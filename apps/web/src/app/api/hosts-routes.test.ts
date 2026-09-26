import assert from "node:assert/strict";
import fs from "node:fs";
import { after, before, beforeEach, test } from "node:test";

// Env setup must stay above every other import — the route modules reach
// @nexux/db, whose client is built (and migrated) at module load.
import { testDbDir } from "./routes.test-setup";
import { NextRequest } from "next/server";
import { prisma } from "@nexux/db";

import { GET as listHosts, POST as createHostRoute } from "./hosts/route";
import { GET as readinessRoute } from "./hosts/readiness/route";
import { DELETE as deleteHost, GET as getHostRoute } from "./hosts/[hostId]/route";

before(async () => {
  await prisma.workspace.create({
    data: { id: "ws-hosts-test", name: "Hosts" },
  });
});

after(async () => {
  delete process.env.NEXUX_TEST_TERRAFORM;
  await prisma.$disconnect();
  fs.rmSync(testDbDir, { recursive: true, force: true });
});

beforeEach(async () => {
  await prisma.nexusHost.deleteMany({});
  await prisma.dockerEndpoint.deleteMany({});
  await prisma.cloudCredential.deleteMany({});
  delete process.env.NEXUX_TEST_DOCKER_PROBE;
  // Never provision for real from a test: the endpoint could be a live machine.
  process.env.NEXUX_TEST_HOST_PROVISION = "skip";
  delete process.env.NEXUX_ROLE;
  // State the environment rather than inheriting it: terraform is installed on
  // a developer machine and absent on CI, so without this the precondition
  // tests below pass in one place and fail in the other — which is exactly
  // what happened the first time this suite ran on CI.
  process.env.NEXUX_TEST_TERRAFORM = "1";
});


const post = (body: unknown) =>
  createHostRoute(
    new NextRequest("http://test/api/hosts", {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
    }),
  );

const validBody = (over: Record<string, unknown> = {}) => ({
  name: "nexus-prod",
  provider: "civo",
  region: "NYC1",
  size: "g3.large",
  ...over,
});

async function saveCivo() {
  return prisma.cloudCredential.create({
    data: {
      workspaceId: "ws-hosts-test",
      name: "civo-main",
      provider: "civo",
      data: { token: "civo-token" },
    },
  });
}

async function saveTailscale() {
  return prisma.cloudCredential.create({
    data: {
      workspaceId: "ws-hosts-test",
      name: "tailnet",
      provider: "tailscale",
      data: { token: "tskey-auth-abc" },
    },
  });
}

async function saveGithub(name = "gh-main", token = "ghp_token") {
  return prisma.cloudCredential.create({
    data: {
      workspaceId: "ws-hosts-test",
      name,
      provider: "github",
      data: { token },
    },
  });
}

const errorOf = async (res: Response) =>
  ((await res.json()) as { error: string }).error;

/**
 * Answer the registry probes without leaving the machine. `assertImagePullable`
 * asks ghcr.io whether the image can be pulled and `resolveHostRegistryAuth`
 * asks GitHub who a token belongs to; a suite that really called them would be
 * offline-flaky and would depend on the state of a real package.
 */
function stubRegistry(status: number, anonymousStatus = status, manifestBody: unknown = null) {
  const real = globalThis.fetch;
  const issuedTo = new Map<string, "auth" | "anon">();
  let issued = 0;

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const headers = (init?.headers ?? {}) as Record<string, string>;

    // A token is issued to anyone who asks — GHCR does this for any valid PAT,
    // which is why the manifest below is what actually decides.
    if (url.startsWith("https://ghcr.io/token")) {
      const kind = headers.Authorization?.startsWith("Basic ") ? "auth" : "anon";
      const token = `t${(issued += 1)}`;
      issuedTo.set(token, kind);
      return new Response(JSON.stringify({ token }), { status: 200 });
    }
    if (url.startsWith("https://ghcr.io/v2/")) {
      const bearer = headers.Authorization?.replace("Bearer ", "");
      // The registry names its own token endpoint in a WWW-Authenticate header.
      if (!bearer) {
        return new Response(null, {
          status: 401,
          headers: {
            "www-authenticate":
              'Bearer realm="https://ghcr.io/token",service="ghcr.io"',
          },
        });
      }
      const answer = issuedTo.get(bearer) === "auth" ? status : anonymousStatus;
      return new Response(answer === 200 && manifestBody ? JSON.stringify(manifestBody) : null, {
        status: answer,
      });
    }
    if (url.startsWith("https://api.github.com/user")) {
      return new Response(JSON.stringify({ login: "octocat" }), {
        status: 200,
      });
    }
    throw new Error(`unexpected fetch in test: ${url}`);
  }) as typeof fetch;
  return () => {
    globalThis.fetch = real;
  };
}

// ---- readiness -------------------------------------------------------------

test("readiness reports each missing precondition", async () => {
  const empty = await (await readinessRoute()).json();
  assert.equal(empty.hasCloudCredential, false);
  assert.equal(empty.hasTailscaleCredential, false);
  assert.equal(typeof empty.defaultImage, "string");

  await saveCivo();
  await saveTailscale();

  const ready = await (await readinessRoute()).json();
  assert.equal(ready.hasCloudCredential, true);
  assert.equal(ready.hasTailscaleCredential, true);
});

test("readiness flags an install that is itself a host", async () => {
  process.env.NEXUX_ROLE = "host";
  const body = await (await readinessRoute()).json();
  assert.equal(body.isHost, true);
});

// ---- creation preconditions ------------------------------------------------

test("creating without a Tailscale credential is refused", async () => {
  await saveCivo();
  const res = await post(validBody());
  assert.equal(res.status, 400);
  // The one precondition worth blocking outright: a VM running an
  // unauthenticated app that cannot join the private network (D-34).
  assert.match(await errorOf(res), /Tailscale/);
  assert.equal(await prisma.nexusHost.count(), 0);
});

test("creating without a cloud credential is refused", async () => {
  await saveTailscale();
  const res = await post(validBody());
  assert.equal(res.status, 400);
  assert.match(await errorOf(res), /Civo credential/);
  assert.equal(await prisma.nexusHost.count(), 0);
});

test("an invalid image reference is refused before anything is provisioned", async () => {
  await saveCivo();
  await saveTailscale();
  const res = await post(validBody({ imageRef: "nexus; rm -rf /" }));
  assert.equal(res.status, 400);
  assert.match(await errorOf(res), /not a valid image reference/);
  assert.equal(await prisma.nexusHost.count(), 0);
});

test("without terraform, creating is refused and readiness says so", async () => {
  // The case CI surfaced: terraform is absent on the runner and present on a
  // developer machine, so this must be asserted explicitly rather than left to
  // whatever the host happens to have installed.
  process.env.NEXUX_TEST_TERRAFORM = "0";
  await saveCivo();
  await saveTailscale();

  const readiness = await (await readinessRoute()).json();
  assert.equal(readiness.terraformInstalled, false);

  const res = await post(validBody());
  assert.equal(res.status, 400);
  assert.match(await errorOf(res), /terraform/);
  assert.equal(await prisma.nexusHost.count(), 0);
});

test("a host install refuses to create further hosts", async () => {
  process.env.NEXUX_ROLE = "host";
  await saveCivo();
  await saveTailscale();
  const res = await post(validBody());
  assert.equal(res.status, 400);
  assert.match(await errorOf(res), /itself a Nexus host/);
});

test("a malformed body is a 400 with field errors", async () => {
  const res = await post({ provider: "civo" });
  assert.equal(res.status, 400);
});

test("an unknown provider is rejected by the schema", async () => {
  await saveCivo();
  await saveTailscale();
  const res = await post(validBody({ provider: "hetzner" }));
  assert.equal(res.status, 400);
});

// ---- registry credentials --------------------------------------------------

test("a private image with no registry credential is refused before provisioning", async () => {
  // The failure this replaced: the VM booted, spent minutes installing Docker
  // and Tailscale, then died on `unauthorized` — with the instance billing.
  const restore = stubRegistry(401);
  try {
    await saveCivo();
    await saveTailscale();
    const res = await post(validBody());
    assert.equal(res.status, 400);
    assert.match(await errorOf(res), /no saved token logs in to ghcr\.io/);
    assert.equal(await prisma.nexusHost.count(), 0);
  } finally {
    restore();
  }
});

test("a registry credential that cannot pull the image is refused", async () => {
  const restore = stubRegistry(403);
  try {
    await saveCivo();
    await saveTailscale();
    const gh = await saveGithub();
    const res = await post(validBody({ registryCredentialId: gh.id }));
    assert.equal(res.status, 400);
    const message = await errorOf(res);
    // Names the token: with several saved, "the credential is wrong" does not
    // say which one to go and fix.
    assert.match(message, /gh-main/);
    assert.match(message, /read:packages/);
    assert.equal(await prisma.nexusHost.count(), 0);
  } finally {
    restore();
  }
});

test("a non-GitHub registry credential is named rather than silently swapped", async () => {
  // resolveGitCredential falls back to the oldest git credential when the id
  // does not resolve; for a registry login that means authenticating as an
  // account the user never chose, which only shows up as `unauthorized`.
  const restore = stubRegistry(200);
  try {
    await saveCivo();
    await saveTailscale();
    await saveGithub();
    const gitlab = await prisma.cloudCredential.create({
      data: {
        workspaceId: "ws-hosts-test",
        name: "gl-main",
        provider: "gitlab",
        data: { token: "glpat-x" },
      },
    });
    const res = await post(validBody({ registryCredentialId: gitlab.id }));
    assert.equal(res.status, 400);
    // Names both registries: "wrong credential" alone does not say what to pick.
    assert.match(
      await errorOf(res),
      /GitLab token, which logs in to registry\.gitlab\.com — not ghcr\.io/,
    );
    assert.equal(await prisma.nexusHost.count(), 0);
  } finally {
    restore();
  }
});

test("a registry host set on a credential is what decides where it can log in", async () => {
  // A self-hosted GitLab serves its registry on the install's own domain, so the
  // provider default is a default, not a rule: with an override, a GitLab token
  // is accepted for an image that is not on registry.gitlab.com.
  const restore = stubRegistry(403);
  try {
    await saveCivo();
    await saveTailscale();
    const cred = await prisma.cloudCredential.create({
      data: {
        workspaceId: "ws-hosts-test",
        name: "self-hosted",
        provider: "gitlab",
        data: { token: "glpat-x", registryHost: "ghcr.io" },
      },
    });
    const res = await post(validBody({ registryCredentialId: cred.id }));
    assert.equal(res.status, 400);
    // Reached the pull check rather than being rejected as the wrong registry.
    assert.match(await errorOf(res), /cannot be pulled from ghcr\.io/);
  } finally {
    restore();
  }
});

test("a deleted registry credential is reported, not replaced", async () => {
  const restore = stubRegistry(200);
  try {
    await saveCivo();
    await saveTailscale();
    await saveGithub();
    const res = await post(validBody({ registryCredentialId: "gone" }));
    assert.equal(res.status, 400);
    assert.match(await errorOf(res), /no longer exists/);
  } finally {
    restore();
  }
});

// ---- listing ---------------------------------------------------------------

test("the list omits destroyed hosts and the log column", async () => {
  await prisma.nexusHost.create({
    data: {
      name: "live",
      status: "running",
      provider: "civo",
      region: "NYC1",
      size: "g3.large",
      imageRef: "ghcr.io/o/r:edge",
      workDir: "/tmp/x",
      log: "a very long terraform log",
      tailscaleIp: "100.64.1.5",
    },
  });
  await prisma.nexusHost.create({
    data: {
      name: "gone",
      status: "destroyed",
      provider: "civo",
      region: "NYC1",
      size: "g3.large",
      imageRef: "ghcr.io/o/r:edge",
      workDir: "/tmp/y",
    },
  });

  const rows = (await (await listHosts()).json()) as Array<
    Record<string, unknown>
  >;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, "live");
  assert.equal(rows[0].tailscaleIp, "100.64.1.5");
  // The log polls on every tick; the detail route serves it instead.
  assert.ok(!("log" in rows[0]));
});

test("the detail route includes the log", async () => {
  const host = await prisma.nexusHost.create({
    data: {
      name: "one",
      status: "bootstrapping",
      provider: "civo",
      region: "NYC1",
      size: "g3.large",
      imageRef: "ghcr.io/o/r:edge",
      workDir: "/tmp/z",
      log: "[nexus-host] installing docker",
    },
  });

  const res = await getHostRoute(new NextRequest("http://test/api/hosts/x"), {
    params: Promise.resolve({ hostId: host.id }),
  });
  const body = (await res.json()) as { log: string };
  assert.equal(res.status, 200);
  assert.match(body.log, /installing docker/);
});

test("an unknown host is a 404", async () => {
  const res = await getHostRoute(new NextRequest("http://test/api/hosts/x"), {
    params: Promise.resolve({ hostId: "nope" }),
  });
  assert.equal(res.status, 404);
});

// ---- destroy ---------------------------------------------------------------

test("destroying a host whose credential is gone explains what to do", async () => {
  // The row outlives the credential (onDelete: SetNull), and a stranded VM is
  // still billed — so the error names the manual step rather than failing mute.
  const host = await prisma.nexusHost.create({
    data: {
      name: "orphan",
      status: "running",
      provider: "civo",
      region: "NYC1",
      size: "g3.large",
      imageRef: "ghcr.io/o/r:edge",
      workDir: "/tmp/orphan",
    },
  });

  const res = await deleteHost(new NextRequest("http://test/api/hosts/x"), {
    params: Promise.resolve({ hostId: host.id }),
  });
  assert.equal(res.status, 400);
  assert.match(await errorOf(res), /provider console/);
});

test("destroying an unknown host is a 400, not a crash", async () => {
  const res = await deleteHost(new NextRequest("http://test/api/hosts/x"), {
    params: Promise.resolve({ hostId: "nope" }),
  });
  assert.equal(res.status, 400);
  assert.match(await errorOf(res), /not found/i);
});

// --- hosts on a Docker endpoint (spec 27) -----------------------------------

async function saveEndpoint() {
  return prisma.dockerEndpoint.create({
    data: { name: "omarchy", host: "ssh://omarchy", arch: "x86_64" },
  });
}

const endpointBody = (dockerEndpointId: string, over: Record<string, unknown> = {}) => ({
  name: "home",
  provider: "docker-endpoint",
  dockerEndpointId,
  imageRef: "ghcr.io/o/r:edge",
  ...over,
});

const AMD64_ONLY = { manifests: [{ platform: { os: "linux", architecture: "amd64" } }] };
const ARM64_ONLY = { manifests: [{ platform: { os: "linux", architecture: "arm64" } }] };

test("an endpoint host needs neither region, size, terraform nor a cloud credential", async () => {
  // Terraform is absent here on purpose: an endpoint host never runs it. The
  // stack itself is not started — the endpoint is fake — only the row matters.
  process.env.NEXUX_TEST_TERRAFORM = "0";
  process.env.NEXUX_TEST_DOCKER_PROBE = JSON.stringify({
    ok: true, serverVersion: "29", arch: "x86_64", memTotalMb: 32000, rootless: false,
  });
  const ep = await saveEndpoint();
  await saveTailscale();
  const restore = stubRegistry(200, 200, AMD64_ONLY);
  try {
    const res = await post(endpointBody(ep.id));
    assert.equal(res.status, 201, await res.clone().text());
    const host = await res.json();
    assert.equal(host.provider, "docker-endpoint");
    assert.equal(host.region, "omarchy");
    assert.equal(host.size, "docker");
    assert.equal(host.dockerEndpointId, ep.id);
    assert.equal(host.credentialId, null);
  } finally {
    restore();
  }
});

test("an image that is not published for the endpoint's architecture is refused before the row", async () => {
  process.env.NEXUX_TEST_DOCKER_PROBE = JSON.stringify({
    ok: true, serverVersion: "29", arch: "x86_64", memTotalMb: 32000, rootless: false,
  });
  const ep = await saveEndpoint();
  await saveTailscale();
  const restore = stubRegistry(200, 200, ARM64_ONLY);
  try {
    const res = await post(endpointBody(ep.id));
    assert.equal(res.status, 400);
    assert.match(await errorOf(res), /linux\/arm64 — "omarchy" is amd64/);
    assert.equal(await prisma.nexusHost.count(), 0);
  } finally {
    restore();
  }
});

test("an endpoint host is refused without an endpoint, a keyed tailscale credential, or a daemon", async () => {
  const ep = await saveEndpoint();
  assert.match(await errorOf(await post(endpointBody(""))), /Pick a Docker endpoint/);
  assert.match(await errorOf(await post(endpointBody(ep.id))), /Tailscale credential with an auth key/);

  await saveTailscale();
  process.env.NEXUX_TEST_DOCKER_PROBE = JSON.stringify({ ok: false, error: "The host didn't answer" });
  assert.match(await errorOf(await post(endpointBody(ep.id))), /isn't answering: The host didn't answer/);
  assert.equal(await prisma.nexusHost.count(), 0);
});

test("a cloud host still needs a region and size", async () => {
  const res = await post({ name: "x", provider: "civo" });
  assert.equal(res.status, 400);
});
