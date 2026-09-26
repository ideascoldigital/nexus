/**
 * Nexus host lifecycle. Spec: `specs/19-nexus-host-provisioning.md`.
 *
 * A host is the 24/7 VM that runs Nexus itself. It reuses the sandbox's
 * Terraform module unchanged — provisioning a cloud instance is the same
 * problem — and differs only in what the instance becomes: Docker + Tailscale
 * + the published image, instead of repo checkouts and agent CLIs.
 *
 * The one rule that shapes everything here: **the app has no authentication**
 * (D-34). A host that cannot join the tailnet must not come up serving on a
 * public interface, so provisioning is refused without a Tailscale credential
 * and the bootstrap treats a missing tailnet address as fatal.
 */

import path from "path";

import { getConfig } from "@nexux/config";
import { prisma } from "@nexux/db";
import {
  applySandbox,
  destroySandbox,
  ensureSandboxKeypair,
  execRemote,
  initialSshUser,
  isValidImageRef,
  parseHostMarker,
  registryHost,
  removeSandboxSshHost,
  renderHostCloudInit,
  safeHostName,
  terraformAvailable,
  HOST_BOOTSTRAP_LOG,
  HOST_MARKER,
  type NexusHostSpec,
} from "@nexux/sandbox";

import {
  resolveGitCredential,
  resolveProviderCredentials,
  resolveTailscaleKey,
} from "@/lib/sandbox-manager";
import { probe as probeEndpoint } from "@/lib/docker-endpoints";
import {
  destroyEndpointHost,
  provisionEndpointHost,
  updateEndpointHost,
  type EndpointUpdateResult,
} from "@/lib/host-endpoint";

// Re-exported for the hosts routes, which historically import it from here.
// The implementation moved to sandbox-manager so sandbox launches can share it
// without a host-manager → sandbox-manager → host-manager cycle.
export { resolveTailscaleKey };

/** Default image a new host pulls; overridable per host. */
export const DEFAULT_HOST_IMAGE = "ghcr.io/ideascoldigital/nexus:edge";

/** Status values a host row moves through. */
export type HostStatus =
  | "pending"
  | "provisioning"
  | "bootstrapping"
  | "running"
  | "error"
  | "destroying"
  | "destroyed";

/**
 * In-flight provision/destroy operations, so a double click cannot start two
 * terraform runs against the same working directory. Mirrors
 * `sandbox-manager`'s `activeOps`.
 */
const activeOps = new Map<string, Promise<unknown>>();

function hostWorkDir(hostId: string): string {
  return path.join(getConfig().dataDir, "hosts", hostId);
}

/**
 * Whether the terraform CLI is usable.
 *
 * Wrapped rather than called directly so tests can state which environment they
 * are simulating instead of inheriting the developer's machine: `terraform` is
 * installed locally and absent on CI, which otherwise makes every
 * precondition test pass in one place and fail in the other. Guarded by an env
 * var rather than a mutable module export, so production has no way to reach
 * it — the same discipline as `NEXUX_TEST_WORKSPACE` in `workspace.ts`.
 */
async function hasTerraform(): Promise<boolean> {
  const override = process.env.NEXUX_TEST_TERRAFORM;
  if (override) return override !== "0";
  return terraformAvailable();
}

async function appendLog(hostId: string, chunk: string): Promise<void> {
  if (!chunk) return;
  const row = await prisma.nexusHost.findUnique({
    where: { id: hostId },
    select: { log: true },
  });
  if (!row) return;
  // Cap the stored log: terraform is chatty and this column is read by the
  // polling UI on every tick.
  const next = (row.log + chunk).slice(-100_000);
  await prisma.nexusHost
    .update({ where: { id: hostId }, data: { log: next } })
    .catch(() => undefined);
}

/**
 * Which git host's token logs in to which registry.
 *
 * Each of these hosts a container registry alongside the repos and accepts the
 * *same* personal access token as the docker password — so a credential already
 * saved in Settings doubles as the registry login rather than being a second
 * secret to manage. The default host is what the provider runs for everyone;
 * self-hosted installs (a company GitLab, GitHub Enterprise) serve a registry on
 * their own domain, which is why the mapping is a default and not a rule — an
 * image on any other host is matched by the credential's own `registryHost`.
 *
 * The scope each token needs differs, and the message that names it is the only
 * thing standing between the user and an `unauthorized` twenty minutes later.
 */
const REGISTRY_BY_PROVIDER: Record<
  string,
  { host: string; label: string; scope: string }
> = {
  github: { host: "ghcr.io", label: "GitHub", scope: "read:packages" },
  gitlab: {
    host: "registry.gitlab.com",
    label: "GitLab",
    scope: "read_registry",
  },
  // Bitbucket has no container registry of its own; a Bitbucket token is still
  // offered, because a self-hosted registry may accept it.
  bitbucket: { host: "", label: "Bitbucket", scope: "read" },
};

/** The registry a saved credential can log in to, default or overridden. */
export function registryHostFor(cred: {
  provider: string;
  registryHost?: string | null;
}): string {
  const override = cred.registryHost?.trim().toLowerCase();
  if (override) return override;
  return REGISTRY_BY_PROVIDER[cred.provider]?.host ?? "";
}

/**
 * Registry login for the host to pull with, when the image lives somewhere that
 * needs one.
 *
 * The credential is chosen rather than inferred: falling back to whichever git
 * token was saved first picks the wrong account as soon as there is more than
 * one, and the mistake only surfaces as `unauthorized` minutes into the
 * bootstrap. An explicit id pointing at the wrong registry is reported here
 * instead, while the machine still costs nothing.
 *
 * Returns null when there is nothing to use, which is the correct outcome for
 * a public package: `docker login` would be pointless, and refusing here would
 * block the common case.
 */
async function resolveHostRegistryAuth(
  imageRef: string,
  credentialId?: string | null,
): Promise<{
  username: string;
  password: string;
  credentialId: string;
  /** The saved credential's name, so errors can point at a specific token. */
  name: string;
  /** Which git host issued it, for messages that have to say so. */
  provider: string;
} | null> {
  const host = registryHost(imageRef);

  const git = await resolveGitCredential(credentialId);
  // `resolveGitCredential` falls back to the oldest git credential when the id
  // does not resolve. That is right for a sandbox and wrong here: logging in as
  // an account the user did not choose fails as `unauthorized` minutes later,
  // pointing at the image rather than at the token.
  if (credentialId && git?.id !== credentialId) {
    throw new Error(
      "The selected registry credential no longer exists. Pick another in Settings → Git.",
    );
  }
  if (!git) return null;

  const credRegistry = registryHostFor(git);
  if (credRegistry !== host) {
    if (credentialId) {
      const label = REGISTRY_BY_PROVIDER[git.provider]?.label ?? git.provider;
      throw new Error(
        credRegistry
          ? `“${git.name}” is a ${label} token, which logs in to ${credRegistry} — not ${host}. Pick a credential for ${host}, or set its registry host.`
          : `“${git.name}” is a ${label} token and ${label} has no container registry. Set the registry host on that credential, or pick a different one.`,
      );
    }
    return null;
  }

  // Registries ignore the username when the password is a PAT, but docker still
  // requires one to be present. Ask GitHub who the token belongs to so the login
  // line is meaningful in the bootstrap log; fall back to a placeholder rather
  // than failing, since the value is not what authenticates. Only GitHub is
  // asked — the others have no equally cheap "who am I" call, and the
  // placeholder works there too.
  let username = "x-access-token";
  if (git.provider === "github") {
    try {
      const res = await fetch("https://api.github.com/user", {
        headers: {
          Authorization: `Bearer ${git.token}`,
          Accept: "application/vnd.github+json",
        },
        signal: AbortSignal.timeout(10_000),
      });
      if (res.ok) {
        const body = (await res.json()) as { login?: unknown };
        if (typeof body.login === "string" && body.login) username = body.login;
      }
    } catch {
      // Offline or rate-limited — the placeholder still authenticates.
    }
  }

  return {
    username,
    password: git.token,
    credentialId: git.id,
    name: git.name,
    provider: git.provider,
  };
}

/** The tag or digest an image reference names; `latest` when it names neither. */
function imageTag(rest: string): string {
  const digest = rest.split("@")[1];
  if (digest) return digest;
  const tag = rest.split("@")[0].split(":")[1];
  return tag || "latest";
}

/**
 * Where a registry issues pull tokens, asked of the registry itself.
 *
 * `HEAD /v2/<repo>/manifests/<tag>` answers 401 with a challenge like
 * `Bearer realm="https://ghcr.io/token",service="ghcr.io"` — the URL to request
 * a scoped token from. Returns null when the registry cannot be reached or does
 * not use token auth, which the caller treats as "no opinion".
 */
async function tokenEndpoint(
  host: string,
  repository: string,
  tag: string,
): Promise<string | null> {
  let challenge: string | null;
  try {
    const res = await fetch(
      `https://${host}/v2/${repository}/manifests/${tag}`,
      { method: "HEAD", signal: AbortSignal.timeout(10_000) },
    );
    challenge = res.headers.get("www-authenticate");
  } catch {
    return null;
  }
  if (!challenge?.toLowerCase().startsWith("bearer ")) return null;

  const realm = challenge.match(/realm="([^"]+)"/i)?.[1];
  if (!realm?.startsWith("https://")) return null;
  const service = challenge.match(/service="([^"]+)"/i)?.[1] ?? host;

  const url = new URL(realm);
  url.searchParams.set("service", service);
  url.searchParams.set("scope", `repository:${repository}:pull`);
  return url.toString();
}

/** Manifest media types `docker pull` accepts; a registry 404s without them. */
const MANIFEST_ACCEPT = [
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
  "application/vnd.docker.distribution.manifest.v2+json",
].join(",");

/**
 * Ask the registry, before anything is provisioned, whether this image can
 * actually be pulled with these credentials.
 *
 * Worth the round trip because the alternative is where this check came from: a
 * VM boots, installs Docker and Tailscale for several minutes, then dies on
 * `unauthorized` — with a bill running and a log that blames the image rather
 * than the token. Anything other than a definite "no" is allowed through: a
 * registry that is unreachable from *this* machine says nothing about the host,
 * and refusing on a network hiccup would be worse than the pull failing.
 *
 * The token endpoint is read from the registry's own `WWW-Authenticate`
 * challenge rather than hardcoded, so this works the same for ghcr.io, GitLab
 * and a self-hosted registry — all of them speak the same Docker auth protocol,
 * they just issue tokens from different URLs.
 */
export async function assertImagePullable<
  T extends { username: string; password: string; name: string },
>(
  imageRef: string,
  registry: T | null,
  /** Whether the user picked this credential, or it was merely the one saved. */
  chosen: boolean,
): Promise<{
  registry: T | null;
  /**
   * `os/arch[/variant]` entries the image publishes, read off its index, or
   * null when that cannot be told from here (a single-platform manifest, an
   * unreachable registry, Docker Hub). Null is "no opinion", never "none".
   */
  platforms: string[] | null;
}> {
  const host = registryHost(imageRef);
  const [maybeHost, ...rest] = imageRef.split("/");
  // Docker Hub is not something a saved git token authenticates against, and an
  // image with no registry component has no host to ask.
  if (!host || host === "docker.io" || maybeHost?.toLowerCase() !== host) {
    return { registry, platforms: null };
  }

  // <host>/<owner>/<name>[:tag] — the tag is not part of the auth scope.
  const path = rest.join("/");
  const repository = path.split("@")[0].split(":")[0];
  if (!repository) return { registry, platforms: null };
  const tag = imageTag(path);

  const realm = await tokenEndpoint(host, repository, tag);
  if (!realm) return { registry, platforms: null }; // Unreachable or not a token registry.

  /**
   * Whether these credentials can actually fetch the manifest — the same
   * request `docker pull` starts with.
   *
   * Getting a token is **not** enough, which is the bug this exists to catch:
   * GHCR issues a token to any authenticated GitHub user, so a PAT without
   * `read:packages` sails through the token endpoint and is denied at the
   * manifest. `docker login` succeeding while the pull fails is exactly that
   * gap. `null` means the probe never got an answer — unreachable from here
   * says nothing about the host, so it passes.
   */
  const probe = async (
    auth: typeof registry,
  ): Promise<{ status: number; platforms: string[] | null } | null> => {
    try {
      const tokenRes = await fetch(realm, {
        headers: auth
          ? {
              Authorization: `Basic ${Buffer.from(
                `${auth.username}:${auth.password}`,
              ).toString("base64")}`,
            }
          : {},
        signal: AbortSignal.timeout(10_000),
      });
      if (!tokenRes.ok) return { status: tokenRes.status, platforms: null };

      const body = (await tokenRes.json()) as {
        token?: unknown;
        access_token?: unknown;
      };
      const bearer =
        typeof body.token === "string"
          ? body.token
          : typeof body.access_token === "string"
            ? body.access_token
            : null;
      if (!bearer) return null;

      // GET rather than HEAD: the index body is a few KB and names the
      // platforms the image is published for (spec 27 — a host on an arm64
      // endpoint cannot run an amd64-only image).
      const manifest = await fetch(
        `https://${host}/v2/${repository}/manifests/${tag}`,
        {
          headers: { Authorization: `Bearer ${bearer}`, Accept: MANIFEST_ACCEPT },
          signal: AbortSignal.timeout(10_000),
        },
      );
      const platforms = manifest.ok
        ? await manifest.json().then(manifestPlatforms, () => null)
        : null;
      return { status: manifest.status, platforms };
    } catch {
      return null;
    }
  };

  const first = await probe(registry);
  const status = first?.status ?? null;
  if (status === null || (status !== 401 && status !== 403 && status !== 404)) {
    return { registry, platforms: first?.platforms ?? null };
  }

  // A rejected credential does not mean the image is unreachable: a token
  // without registry access makes the registry refuse an image that anyone
  // could have pulled anonymously. Drop it and pull as nobody rather than fail
  // on a token nothing needed — unless the user picked it, in which case
  // silently ignoring the choice would be worse than saying it does not work.
  //
  // Anything that is not an auth refusal counts as "anonymous does better":
  // a 404 there is the registry answering about the *tag*, which is a verdict
  // on the image and not on the credential, and blaming the token for it sends
  // the user to fix the wrong thing.
  if (registry && !chosen) {
    const anonProbe = await probe(null);
    const anon = anonProbe?.status ?? null;
    if (anon === null || (anon !== 401 && anon !== 403 && anon !== 404)) {
      return { registry: null, platforms: anonProbe?.platforms ?? null };
    }
    // Anonymous says the tag is missing rather than forbidden: that is about
    // the image, so report it as such instead of blaming a token.
    if (anon === 404) {
      throw new Error(
        `${host}/${repository} has no tag “${tag}”. Check the tag — no registry credential changes that.`,
      );
    }
  }

  // A 404 on an authenticated request is the registry saying the *tag* is not
  // there — a different mistake from a permissions one, and one the token can
  // do nothing about.
  if (status === 404 && registry) {
    throw new Error(
      `${host}/${repository} has no tag “${tag}” that “${registry.name}” can see. Check the tag, or whether that token has access to the package.`,
    );
  }

  // The scope a read-only registry token needs, which differs per provider and
  // is the single most common thing to have got wrong — a GitHub PAT with only
  // `repo` authenticates against GHCR and is then denied at the pull.
  const scope = Object.values(REGISTRY_BY_PROVIDER).find(
    (r) => r.host === host,
  )?.scope;

  throw new Error(
    registry
      ? `${repository}:${tag} cannot be pulled from ${host} with “${registry.name}”.${
          scope
            ? ` That token needs the ${scope} scope and access to the package`
            : " That token needs access to the image"
        } — logging in is not enough, and a token without it fails only at the pull.`
      : `${repository}:${tag} is private and no saved token logs in to ${host}. Add one in Settings → Git and pick it under “Registry credential” — or make the image public.`,
  );
}

/**
 * Platforms an image index lists, as `os/arch[/variant]`. Null for anything
 * that is not an index — a single-platform manifest names its platform only in
 * its config blob, which is not worth a third request here.
 */
export function manifestPlatforms(body: unknown): string[] | null {
  const manifests = (body as { manifests?: unknown })?.manifests;
  if (!Array.isArray(manifests)) return null;
  const out = manifests
    .map((m) => (m as { platform?: { os?: unknown; architecture?: unknown; variant?: unknown } }).platform)
    .filter((p) => p && typeof p.os === "string" && typeof p.architecture === "string")
    // Attestation manifests ("unknown/unknown") describe provenance, not a platform.
    .filter((p) => p!.os !== "unknown")
    .map((p) => [p!.os, p!.architecture, typeof p!.variant === "string" ? p!.variant : null].filter(Boolean).join("/"));
  return out.length ? out : null;
}

/** `docker info`'s Architecture in the names image indexes use. */
export function ociArch(dockerArch: string): string {
  const a = dockerArch.toLowerCase();
  if (a === "x86_64" || a === "amd64") return "amd64";
  if (a === "aarch64" || a === "arm64") return "arm64";
  if (a.startsWith("armv7")) return "arm";
  return a;
}

export type HostReadiness = {
  terraformInstalled: boolean;
  hasCloudCredential: boolean;
  hasTailscaleCredential: boolean;
  /** Whether this install is itself running as a host (panel hides itself). */
  isHost: boolean;
  /**
   * When it is a host: a VM (can update itself) or a stack on a Docker
   * endpoint (spec 27 — updated from the install that created it).
   */
  hostKind: "vm" | "endpoint" | null;
};

/**
 * What the form needs to explain *before* it is filled in why Create is
 * disabled. Deliberately does not probe the registry: that costs a network
 * round trip on every page load, and a bad image reference is caught at
 * creation with a clearer message.
 */
export async function getHostReadiness(): Promise<HostReadiness> {
  const [terraformInstalled, cloud, tailscale] = await Promise.all([
    hasTerraform(),
    prisma.cloudCredential.count({ where: { provider: { in: ["civo", "aws"] } } }),
    prisma.cloudCredential.count({ where: { provider: "tailscale" } }),
  ]);
  return {
    terraformInstalled,
    hasCloudCredential: cloud > 0,
    hasTailscaleCredential: tailscale > 0,
    isHost: process.env.NEXUX_ROLE === "host",
    hostKind:
      process.env.NEXUX_ROLE !== "host"
        ? null
        : process.env.NEXUX_HOST_KIND === "endpoint"
          ? "endpoint"
          : "vm",
  };
}

export type CreateHostInput = {
  name: string;
  /** "docker-endpoint": the stack runs on a machine you already have (spec 27). */
  provider: "civo" | "aws" | "docker-endpoint";
  /** Which Docker endpoint, for provider "docker-endpoint". */
  dockerEndpointId?: string | null;
  credentialId?: string | null;
  tailscaleCredentialId?: string | null;
  /** Git credential the host logs in to the image registry with (GHCR). */
  registryCredentialId?: string | null;
  region: string;
  size: string;
  diskImage?: string;
  imageRef?: string;
  pullEmbeddingModel?: boolean;
  setupScript?: string | null;
};

/**
 * Validate, create the row, and kick off provisioning in the background.
 * Returns as soon as the row exists — the caller polls for status.
 */
export async function createHost(input: CreateHostInput) {
  if (process.env.NEXUX_ROLE === "host") {
    throw new Error(
      "This install is itself a Nexus host. Create hosts from your local install.",
    );
  }
  if (input.provider === "docker-endpoint") return createEndpointHost(input);
  if (!(await hasTerraform())) {
    throw new Error(
      "terraform CLI not found. Install it from developer.hashicorp.com/terraform and restart Nexus.",
    );
  }

  const name = safeHostName(input.name);
  const imageRef = (input.imageRef || DEFAULT_HOST_IMAGE).trim();
  if (!isValidImageRef(imageRef)) {
    throw new Error(
      `"${imageRef}" is not a valid image reference (expected something like ghcr.io/owner/repo:tag).`,
    );
  }

  const cloud = await resolveProviderCredentials(
    input.provider,
    input.credentialId,
  );
  if (!cloud) {
    throw new Error(
      input.provider === "aws"
        ? "No AWS credential found. Save one in Settings → Cloud first."
        : "No Civo credential found. Save one in Settings → Cloud first.",
    );
  }

  // Refused rather than defaulted: a host that cannot join the tailnet would
  // serve an app with no authentication on a public address (D-34).
  const tailscale = await resolveTailscaleKey(input.tailscaleCredentialId);
  if (!tailscale) {
    throw new Error(
      "No Tailscale auth key found. Save one in Settings → Cloud (provider “Tailscale”) — it must be ephemeral, pre-authorized and reusable.",
    );
  }
  // A sandbox can fall back to interactive registration; a host cannot. Its
  // bootstrap is unattended and aborts on a failed join (D-34), so a
  // credential that only names a control server would strand it.
  if (!tailscale.authKey) {
    throw new Error(
      "That Tailscale credential has no auth key — a host bootstraps unattended and cannot complete a browser login. Save a credential with an auth key for the control server it should join.",
    );
  }

  // A private GHCR package needs credentials on the instance to pull. GitHub
  // accepts a PAT with read:packages as the docker password, so a saved git
  // credential doubles as the registry login — no second secret to manage.
  // Public packages need none of this, which is why the absence of a token is
  // not an error on its own; `assertImagePullable` is what decides.
  //
  // Both run *before* the row exists: a wrong token is the failure this catches,
  // and discovering it after terraform has launched an instance means paying for
  // a machine that was never going to work.
  const resolved = await resolveHostRegistryAuth(
    imageRef,
    input.registryCredentialId,
  );
  const { registry } = await assertImagePullable(
    imageRef,
    resolved,
    Boolean(input.registryCredentialId),
  );

  const host = await prisma.nexusHost.create({
    data: {
      name,
      status: "pending",
      provider: input.provider,
      credentialId: cloud.credentialId,
      tailscaleCredentialId: tailscale.credentialId,
      registryCredentialId: registry?.credentialId ?? null,
      region: input.region,
      size: input.size,
      diskImage: input.diskImage || "ubuntu-jammy",
      imageRef,
      pullEmbeddingModel: input.pullEmbeddingModel ?? true,
      workDir: "",
    },
  });

  const workDir = hostWorkDir(host.id);
  await prisma.nexusHost.update({
    where: { id: host.id },
    data: { workDir },
  });

  const spec: NexusHostSpec = {
    name,
    imageRef,
    tailscaleAuthKey: tailscale.authKey,
    tailscaleLoginServer: tailscale.loginServer,
    pullEmbeddingModel: input.pullEmbeddingModel ?? true,
    setupScript: input.setupScript ?? null,
    registry,
  };

  const op = provisionHost(host.id, spec, {
    provider: input.provider,
    region: input.region,
    size: input.size,
    diskImage: input.diskImage || "ubuntu-jammy",
    credentials: cloud.env,
  }).catch(async (err: unknown) => {
    await prisma.nexusHost
      .update({
        where: { id: host.id },
        data: {
          status: "error",
          error: err instanceof Error ? err.message : String(err),
        },
      })
      .catch(() => undefined);
  });
  activeOps.set(host.id, op);
  void op.finally(() => activeOps.delete(host.id));

  return prisma.nexusHost.findUnique({ where: { id: host.id } });
}

/**
 * A host whose stack runs on a Docker endpoint (spec 27). Same discipline as a
 * VM host: every precondition that can be checked is checked before the row
 * exists — here there is no bill, but a host that can never start is still a
 * row the user has to understand and clean up.
 */
async function createEndpointHost(input: CreateHostInput) {
  const name = safeHostName(input.name);
  const imageRef = (input.imageRef || DEFAULT_HOST_IMAGE).trim();
  if (!isValidImageRef(imageRef)) {
    throw new Error(
      `"${imageRef}" is not a valid image reference (expected something like ghcr.io/owner/repo:tag).`,
    );
  }

  const endpoint = input.dockerEndpointId
    ? await prisma.dockerEndpoint.findUnique({ where: { id: input.dockerEndpointId } })
    : null;
  if (!endpoint) {
    throw new Error("Pick a Docker endpoint (Settings → Cloud → Docker endpoints).");
  }

  // Two stacks with one project name on one daemon would be one stack.
  const taken = await prisma.nexusHost.findFirst({
    where: { name, status: { not: "destroyed" } },
    select: { id: true },
  });
  if (taken) throw new Error(`There is already a host called "${name}".`);

  // Same rule as a VM host (D-34), for the same reason: the stack publishes
  // nothing, so a Tailscale that cannot join unattended is a host nobody can
  // reach — and there is no other door it should have.
  const tailscale = await resolveTailscaleKey(input.tailscaleCredentialId);
  if (!tailscale?.authKey) {
    throw new Error(
      "A host needs a Tailscale credential with an auth key (Settings → Cloud) — it starts unattended and cannot complete a browser login.",
    );
  }

  // Reachable now, and the architecture the image must match.
  const probed = await probeEndpoint(endpoint.host);
  if (!probed.ok) {
    throw new Error(`Docker on "${endpoint.name}" isn't answering: ${probed.error}`);
  }

  const resolved = await resolveHostRegistryAuth(imageRef, input.registryCredentialId);
  const { registry, platforms } = await assertImagePullable(
    imageRef,
    resolved,
    Boolean(input.registryCredentialId),
  );
  const arch = probed.arch ? ociArch(probed.arch) : null;
  if (arch && platforms && !platforms.some((p) => p.split("/")[1] === arch)) {
    throw new Error(
      `${imageRef} is published for ${platforms.join(", ")} — "${endpoint.name}" is ${arch}, so it could never start there.`,
    );
  }

  const host = await prisma.nexusHost.create({
    data: {
      name,
      status: "pending",
      provider: "docker-endpoint",
      dockerEndpointId: endpoint.id,
      tailscaleCredentialId: tailscale.credentialId,
      registryCredentialId: registry?.credentialId ?? null,
      // What the list shows as "where" and "what": the machine, and Docker.
      region: endpoint.name,
      size: "docker",
      diskImage: "",
      imageRef,
      pullEmbeddingModel: input.pullEmbeddingModel ?? true,
      workDir: "",
    },
  });
  const workDir = hostWorkDir(host.id);
  await prisma.nexusHost.update({ where: { id: host.id }, data: { workDir } });

  // Route tests stop here: the row is what they check, and the endpoint they
  // name may well be a real machine on this network. Env-guarded like
  // NEXUX_TEST_TERRAFORM, so production cannot reach it.
  if (process.env.NEXUX_TEST_HOST_PROVISION === "skip") {
    return prisma.nexusHost.findUnique({ where: { id: host.id } });
  }

  const op = provisionEndpointHost(
    {
      name,
      imageRef,
      dockerHost: endpoint.host,
      workDir,
      tailscaleAuthKey: tailscale.authKey,
      tailscaleLoginServer: tailscale.loginServer,
      registry: registry
        ? { host: registryHost(imageRef), username: registry.username, password: registry.password }
        : null,
      pullEmbeddingModel: input.pullEmbeddingModel ?? true,
    },
    {
      log: (chunk) => void appendLog(host.id, chunk),
      update: async (data) => {
        await prisma.nexusHost.update({ where: { id: host.id }, data });
      },
    },
  ).catch(async (err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    await appendLog(host.id, `[nexus-host] ERROR: ${message}\n`);
    await prisma.nexusHost
      .update({ where: { id: host.id }, data: { status: "error", error: message } })
      .catch(() => undefined);
  });
  activeOps.set(host.id, op);
  void op.finally(() => activeOps.delete(host.id));

  return prisma.nexusHost.findUnique({ where: { id: host.id } });
}

/**
 * Destroy a host whose stack runs on a Docker endpoint (spec 27): its
 * containers and volumes there, its files here. Awaited like the VM path, so
 * the route answers with the outcome.
 */
async function destroyOnEndpoint(host: { id: string; name: string; workDir: string; dockerEndpointId: string | null }) {
  const endpoint = host.dockerEndpointId
    ? await prisma.dockerEndpoint.findUnique({ where: { id: host.dockerEndpointId } })
    : null;
  if (!endpoint) {
    throw new Error("The Docker endpoint this host ran on is gone — nothing left to remove it from.");
  }
  await prisma.nexusHost.update({
    where: { id: host.id },
    data: { status: "destroying", error: null },
  });
  const op = destroyEndpointHost(
    { name: host.name, dockerHost: endpoint.host, workDir: host.workDir },
    { log: (chunk) => void appendLog(host.id, chunk) },
  )
    .then(() =>
      prisma.nexusHost.update({
        where: { id: host.id },
        data: { status: "destroyed", destroyedAt: new Date() },
      }),
    )
    .catch(async (err: unknown) => {
      await prisma.nexusHost.update({
        where: { id: host.id },
        data: { status: "error", error: err instanceof Error ? err.message : String(err) },
      });
      throw err;
    });
  activeOps.set(host.id, op);
  void op.finally(() => activeOps.delete(host.id));
  await op;
  return prisma.nexusHost.findUnique({ where: { id: host.id } });
}

/**
 * Update a host on a Docker endpoint from this install (spec 27): pull and
 * `up -d` through `docker -H`. A private image logs in again with the
 * credential it was created with — resolved now, since a token can have
 * rotated since.
 */
export async function updateHostOnEndpoint(host: {
  name: string;
  imageRef: string;
  workDir: string;
  dockerEndpointId: string | null;
  registryCredentialId: string | null;
}): Promise<EndpointUpdateResult> {
  const endpoint = host.dockerEndpointId
    ? await prisma.dockerEndpoint.findUnique({ where: { id: host.dockerEndpointId } })
    : null;
  if (!endpoint) throw new Error("The Docker endpoint this host runs on is gone.");
  const registry = host.registryCredentialId
    ? await resolveHostRegistryAuth(host.imageRef, host.registryCredentialId)
    : null;
  return updateEndpointHost({
    name: host.name,
    imageRef: host.imageRef,
    dockerHost: endpoint.host,
    workDir: host.workDir,
    registry: registry
      ? { host: registryHost(host.imageRef), username: registry.username, password: registry.password }
      : null,
  });
}

async function provisionHost(
  hostId: string,
  spec: NexusHostSpec,
  opts: {
    provider: "civo" | "aws";
    region: string;
    size: string;
    diskImage: string;
    credentials: Record<string, string>;
  },
): Promise<void> {
  const workDir = hostWorkDir(hostId);
  await prisma.nexusHost.update({
    where: { id: hostId },
    data: { status: "provisioning", error: null },
  });

  const keypair = ensureSandboxKeypair(getConfig().dataDir);

  // The host bootstrap is rendered here and handed to the shared provisioner
  // as the instance's cloud-init. `applySandbox` writes main.tf + tfvars from
  // the sandbox spec shape, so a minimal one is assembled that carries only
  // the fields the Terraform module actually reads.
  const outputs = await applySandbox({
    workDir,
    spec: {
      provider: opts.provider,
      name: spec.name,
      region: opts.region,
      size: opts.size,
      diskImage: opts.diskImage,
      sshPublicKey: keypair.publicKey,
      installDocker: false,
      installNode: false,
      installClaudeCode: false,
      installAgentBrowser: false,
      installCloudflared: false,
      envVars: {},
      repos: [],
    },
    credentials: opts.credentials,
    onLog: (chunk) => void appendLog(hostId, chunk),
    // The host's own bootstrap replaces the sandbox one entirely. The keypair
    // is injected here rather than at the call site because this is where it
    // is resolved — the bootstrap re-authorizes it for root, which providers
    // do not do (see initialSshUser).
    cloudInit: renderHostCloudInit({
      ...spec,
      authorizedKeys: [keypair.publicKey],
    }),
  });

  await prisma.nexusHost.update({
    where: { id: hostId },
    data: {
      status: "bootstrapping",
      instanceId: outputs.instanceId ?? null,
      publicIp: outputs.publicIp ?? null,
    },
  });

  await waitForBootstrap(hostId, outputs.publicIp ?? null, {
    privateKeyPath: keypair.privateKeyPath,
    // The provider's own account, not root: the bootstrap re-authorizes root
    // but the monitor starts polling *while* cloud-init is still running, so
    // for the first minutes root is still refusing with "Please login as the
    // user \"ubuntu\"".
    user: initialSshUser(opts.provider),
  });
}

/**
 * Poll the instance over SSH until the completion marker appears.
 *
 * The marker carries the resolved Tailscale address, so one read answers both
 * "is it done?" and "where does it live?". A missing marker means keep
 * waiting, never "failed" — the bootstrap pulls an image and can legitimately
 * take several minutes.
 */
async function waitForBootstrap(
  hostId: string,
  publicIp: string | null,
  ssh: { privateKeyPath: string; user: string },
): Promise<void> {
  if (!publicIp) {
    throw new Error(
      "The provider did not report a public IP, so the bootstrap cannot be monitored.",
    );
  }

  const deadline = Date.now() + 15 * 60_000;
  let lastLogLength = 0;

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 10_000));

    // `sudo -n` (never prompt): both files are written by cloud-init as root,
    // and the provider's initial account is unprivileged. It is passwordless on
    // every image here; if it were not, the read fails and polling continues
    // rather than hanging on a prompt.
    const marker = await execRemote(
      `sudo -n cat ${HOST_MARKER} 2>/dev/null || cat ${HOST_MARKER} 2>/dev/null || true`,
      { host: publicIp, ...ssh, timeoutMs: 20_000 },
    ).catch(() => null);

    // Stream whatever is new in the bootstrap log so a failure is readable
    // without SSH-ing in.
    const log = await execRemote(
      `sudo -n tail -c 4000 ${HOST_BOOTSTRAP_LOG} 2>/dev/null || tail -c 4000 ${HOST_BOOTSTRAP_LOG} 2>/dev/null || true`,
      { host: publicIp, ...ssh, timeoutMs: 20_000 },
    ).catch(() => null);
    if (log?.stdout && log.stdout.length !== lastLogLength) {
      lastLogLength = log.stdout.length;
      await prisma.nexusHost
        .update({
          where: { id: hostId },
          data: { log: log.stdout.slice(-100_000) },
        })
        .catch(() => undefined);
    }

    const parsed = marker?.stdout ? parseHostMarker(marker.stdout) : null;
    if (parsed) {
      await prisma.nexusHost.update({
        where: { id: hostId },
        data: {
          status: "running",
          tailscaleIp: parsed.tailscaleIp,
          error: null,
        },
      });
      return;
    }
  }

  // Timed out. The row stays visible with its error and a working Destroy —
  // a half-provisioned host still costs money.
  await prisma.nexusHost.update({
    where: { id: hostId },
    data: {
      status: "error",
      error:
        "The bootstrap did not finish within 15 minutes. Check the log — the image pull or the Tailscale join is the usual cause.",
    },
  });
}

/** Terraform destroy, then mark the row destroyed. */
export async function destroyHost(hostId: string) {
  const host = await prisma.nexusHost.findUnique({ where: { id: hostId } });
  if (!host) throw new Error("Host not found");
  if (host.status === "destroyed") return host;

  const existing = activeOps.get(hostId);
  if (existing) await existing.catch(() => undefined);

  if (host.provider === "docker-endpoint") return destroyOnEndpoint(host);

  const cloud = await resolveProviderCredentials(host.provider, host.credentialId);
  if (!cloud) {
    throw new Error(
      "The credential this host was created with is gone — destroy it from the provider console, then remove the row.",
    );
  }

  await prisma.nexusHost.update({
    where: { id: hostId },
    data: { status: "destroying", error: null },
  });

  const op = destroySandbox({
    workDir: host.workDir,
    credentials: cloud.env,
    onLog: (chunk) => void appendLog(hostId, chunk),
  })
    .then(async () => {
      // The alias in the managed SSH config points at an address that no
      // longer exists — leaving it behind means `ssh <name>` hangs on a dead
      // IP. Best-effort: the VM is gone either way.
      try {
        removeSandboxSshHost(getConfig().dataDir, host.name);
      } catch {
        // ignore — a stale Host block is not worth failing a destroy over
      }
      await prisma.nexusHost.update({
        where: { id: hostId },
        data: { status: "destroyed", destroyedAt: new Date() },
      });
    })
    .catch(async (err: unknown) => {
      await prisma.nexusHost.update({
        where: { id: hostId },
        data: {
          status: "error",
          error: err instanceof Error ? err.message : String(err),
        },
      });
      throw err;
    });

  activeOps.set(hostId, op);
  void op.finally(() => activeOps.delete(hostId));
  await op;

  return prisma.nexusHost.findUnique({ where: { id: hostId } });
}
