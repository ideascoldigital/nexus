import path from "path";
import { randomUUID } from "crypto";
import { prisma, type Sandbox, type SandboxConfig } from "@nexux/db";
import { getConfig } from "@nexux/config";
import {
  applyGlobalSecrets,
  applyLlmCredentials,
  applySandbox,
  BOOTSTRAP_COMPLETE_MARKER,
  BOOTSTRAP_FAILED_MARKER,
  destroySandbox,
  GLOBAL_ENV_SETTINGS,
  destroyLocalSandbox,
  bootstrapReportCommand,
  dockerAvailable,
  ensureSandboxKeypair,
  execRemote,
  failedSteps,
  parseBootstrapReport,
  launchLocalSandbox,
  localBootstrapComplete,
  localBootstrapFailure,
  localSandboxRunning,
  parseTailscaleAuthUrl,
  pickMainRepo,
  removeSandboxSshHost,
  renderRepoSetup,
  renderTailscaleLogin,
  safeSlug,
  sandboxInstanceName,
  customSandboxName,
  localContainerExists,
  DEFAULT_SANDBOX_PREFIX,
  MAX_CUSTOM_NAME_LENGTH,
  terraformAvailable,
  type ProviderCredentials,
  type SandboxProvider,
  type SandboxSpec,
  pauseLocalSandbox,
  resumeLocalSandbox,
} from "@nexux/sandbox";
import {
  buildSandboxStackCompose,
  type SandboxStackCompose,
} from "@/lib/stack/sandbox-compose";
import { sandboxTarget } from "@/lib/agent-core";
import type { DockerTarget } from "@nexux/sandbox";
import {
  gitProviderOfUrl,
  gitProvidersForRepos,
  selfHostedGitLabHost,
  type GitProvider,
} from "@/lib/git-host";
import { getStackInheritance } from "@/lib/stack/sandbox-inheritance";
import { notifySandboxStatus } from "@/lib/notify";
import { sandboxPrefixForProject } from "@/lib/sandbox-prefix";
import { getWorkspaceSetting } from "@/lib/workspace";

export const SANDBOX_CONFIG_DEFAULTS = {
  provider: "civo",
  credentialId: null as string | null,
  githubCredentialId: null as string | null,
  claudeCredentialId: null as string | null,
  region: "NYC1",
  size: "g4s.medium",
  diskImage: "ubuntu-jammy",
  branch: null as string | null,
  sshPublicKey: null as string | null,
  installDocker: true,
  installNode: true,
  installClaudeCode: true,
  installAgentBrowser: true,
  installCloudflared: true,
  installBrowserSession: false,
  installTailscale: false,
  tailscaleCredentialId: null as string | null,
  includeStackServices: true,
  telegramChatId: null as string | null,
  setupScript: null as string | null,
  mcpServers: null as Record<string, unknown> | null,
  agentInstructions: null as string | null,
  createPr: true,
  runTests: true,
  captureScreenshots: true,
  livePreview: false,
  previewPort: 3000,
  claudeModel: null as string | null,
  brain: "claude",
  openCodeModel: null as string | null,
  installOpenCode: false,
};

// Tracks in-flight terraform operations so a sandbox can't be applied and
// destroyed concurrently. Survives dev-mode hot reloads like the prisma global.
const globalForSandbox = globalThis as unknown as {
  nexuxSandboxOps: Set<string> | undefined;
};
const activeOps = (globalForSandbox.nexuxSandboxOps ??= new Set<string>());

export async function getCivoToken(): Promise<string | null> {
  const setting = await prisma.settings.findFirst({
    where: {
      isActive: true,
      OR: [{ key: "civo_api_key" }, { provider: "civo" }],
    },
  });
  return setting?.value ?? process.env.CIVO_TOKEN ?? null;
}

/** Legacy single Claude Code token: Settings row or process env. */
async function getLegacyClaudeCodeToken(): Promise<string | null> {
  const setting = await prisma.settings.findFirst({
    where: { isActive: true, key: "claude_code_oauth_token" },
  });
  return setting?.value ?? process.env.CLAUDE_CODE_OAUTH_TOKEN ?? null;
}

/**
 * Claude Code OAuth token to inject as CLAUDE_CODE_OAUTH_TOKEN at launch:
 * the selected "claude" credential → the oldest saved one → the legacy
 * Settings row / process env. Credentials are global — never scoped by
 * workspace. A project env var with the same name always wins (handled by
 * the caller). `name` is null for the legacy Settings/env fallback.
 */
export async function resolveClaudeCodeToken(
  credentialId?: string | null,
): Promise<{ token: string; name: string | null } | null> {
  if (credentialId) {
    const cred = await prisma.cloudCredential.findUnique({
      where: { id: credentialId },
    });
    if (cred && cred.provider === "claude") {
      const token = (cred.data as CredentialData | null)?.token;
      if (token) return { token, name: cred.name };
    }
  }
  const first = await prisma.cloudCredential.findFirst({
    where: { provider: "claude" },
    orderBy: { createdAt: "asc" },
  });
  const token = (first?.data as CredentialData | null)?.token;
  if (first && token) return { token, name: first.name };
  const legacy = await getLegacyClaudeCodeToken();
  return legacy ? { token: legacy, name: null } : null;
}

/**
 * The Tailscale auth key from a saved credential, if it holds one: the
 * selected "tailscale" credential → the oldest saved one. Shared by sandbox
 * launches and Nexus host provisioning (host-manager re-exports it).
 */
export async function resolveTailscaleKey(
  credentialId?: string | null,
): Promise<{
  /** Null when the tailnet is joined by interactive registration instead. */
  authKey: string | null;
  /** `--login-server` for a self-hosted control plane; null = Tailscale's own. */
  loginServer: string | null;
  credentialId: string;
} | null> {
  const cred = credentialId
    ? await prisma.cloudCredential.findUnique({ where: { id: credentialId } })
    : await prisma.cloudCredential.findFirst({
        where: { provider: "tailscale" },
        orderBy: { createdAt: "asc" },
      });
  if (!cred || cred.provider !== "tailscale") return null;
  const data = (cred.data ?? {}) as {
    authKey?: unknown;
    token?: unknown;
    loginServer?: unknown;
  };
  const key =
    typeof data.authKey === "string"
      ? data.authKey
      : typeof data.token === "string"
        ? data.token
        : null;
  const loginServer =
    typeof data.loginServer === "string" ? data.loginServer.trim() : "";
  const authKey = key?.trim() || null;
  // A credential carrying neither is indistinguishable from having none.
  if (!authKey && !loginServer) return null;
  return {
    authKey,
    loginServer: loginServer || null,
    credentialId: cred.id,
  };
}

/**
 * The tailnet a project's sandboxes join, if any — what the UI needs to decide
 * whether to offer the "refresh Tailscale session" action, and against which
 * control plane.
 */
export async function projectTailnet(
  projectId: string,
): Promise<{ loginServer: string | null; hasAuthKey: boolean } | null> {
  const cfg = await prisma.sandboxConfig.findUnique({ where: { projectId } });
  if (!cfg?.installTailscale) return null;
  const ts = await resolveTailscaleKey(cfg.tailscaleCredentialId);
  // Configured to join but with no usable credential: still worth surfacing,
  // since the action is exactly what recovers from that.
  return { loginServer: ts?.loginServer ?? null, hasAuthKey: Boolean(ts?.authKey) };
}

/**
 * Re-run the tailnet join on a live sandbox and report the URL it is waiting
 * on, if any.
 *
 * Exists because the bootstrap's registration URL is only ever *announced*:
 * it goes into a log the UI tails 400 lines of, and the tailscale section runs
 * early, so on a busy bootstrap the one actionable link scrolls out of reach
 * before anybody clicks it. A registration nobody can find is the same as no
 * registration — this makes it retrievable on demand instead of catchable in
 * passing.
 */
export async function refreshTailscaleSession(sandboxId: string): Promise<{
  authUrl: string | null;
  message: string;
}> {
  const sandbox = await prisma.sandbox.findUnique({ where: { id: sandboxId } });
  if (!sandbox) throw new Error("Sandbox not found");
  const tailnet = await projectTailnet(sandbox.projectId);
  if (!tailnet) {
    throw new Error(
      "This project's sandboxes are not configured to join a tailnet.",
    );
  }

  // Root, not the agent user: `tailscale up` talks to tailscaled's socket.
  const target = sandboxTarget(sandbox, "/", "root");
  const script = renderTailscaleLogin({
    name: sandbox.name,
    loginServer: tailnet.loginServer,
    // Shorter than the bootstrap's: this one is holding an HTTP request open,
    // and a registration that has not printed its URL in 25s is not going to.
    waitSeconds: 25,
  });
  const res = await execRemote(script, { ...target, timeoutMs: 60_000 });
  const out = `${res.stdout}\n${res.stderr}`;

  const authUrl = parseTailscaleAuthUrl(out);
  if (authUrl) {
    return { authUrl, message: "Open the link to approve this sandbox." };
  }
  const joined = out.match(/tailscale joined as \S+: (\S+)/);
  if (joined) {
    // Persisted here rather than left to the next readiness poll: approving the
    // registration is followed immediately by "Retry setup", and that action is
    // gated on this exact field (see retrySandboxSetup below). Without it the
    // retry refuses with "not on the tailnet yet" on a sandbox that plainly is.
    if (joined[1] !== sandbox.tailscaleIp) {
      await prisma.sandbox
        .update({ where: { id: sandbox.id }, data: { tailscaleIp: joined[1] } })
        .catch(() => undefined);
    }
    return { authUrl: null, message: `Already on the tailnet as ${joined[1]}.` };
  }
  // The binary is missing outright — its bootstrap install failed, almost
  // always because unattended-upgrades held the dpkg lock. Named explicitly
  // because it is the one cause the generic advice below actively misleads on:
  // the bootstrap log does hold the reason, hundreds of lines above the tail
  // the UI shows, so "check the bootstrap log" sends people somewhere the
  // answer is not.
  if (/tailscale: (command )?not found/i.test(out)) {
    return {
      authUrl: null,
      message:
        "tailscale is not installed on this sandbox — the bootstrap's install failed. " +
        "Install it over SSH with `curl -fsSL https://tailscale.com/install.sh | sh && systemctl enable --now tailscaled`, then try again.",
    };
  }
  // Otherwise hand back what the script actually said. A fixed string here
  // costs a debugging session every time: the difference between "registration
  // is still pending" and a hard failure is in that last line, and nothing
  // else in the UI carries it.
  const lastLine = out
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .pop();
  return {
    authUrl: null,
    message: lastLine
      ? `tailscale produced no registration URL — last output: ${lastLine}`
      : "tailscale produced no registration URL, and printed nothing at all.",
  };
}

/**
 * Re-run the repo half of the bootstrap on a live sandbox: clone what is
 * missing, install and build it, rewrite the workspace file.
 *
 * The case it exists for is a setup that failed for a reason since fixed —
 * overwhelmingly a git host that was not reachable yet, because the tailnet
 * registration had not been approved when the bootstrap reached the clone.
 * Recreating the sandbox costs another full provision and re-runs the same
 * race; this re-runs only the part that lost it.
 *
 * It renders through `renderRepoSetup`, the same function the bootstrap uses,
 * so there is no second definition of what "set up" means.
 */
/**
 * The pre-spec-24 failure signal: WARN lines in the setup log.
 *
 * Kept as a fallback for sandboxes provisioned before the step recorder
 * existed, which have no report file to read. It sees only clone/install/build
 * — that blindness is why the report replaced it.
 */
function scrapeFailuresFromLog(log: string): string[] {
  return [
    ...log.matchAll(/^\[nexux\] WARN: (?:clone|install|build) failed for (.+?)\r?$/gm),
  ].map((m) => m[1]);
}

export async function retrySandboxSetup(sandboxId: string): Promise<{
  ok: boolean;
  failed: string[];
  log: string;
}> {
  const sandbox = await prisma.sandbox.findUnique({ where: { id: sandboxId } });
  if (!sandbox) throw new Error("Sandbox not found");

  // Refused rather than attempted: each unreachable repo costs ~130s of TCP
  // timeout before git gives up, so running this on a machine that is still
  // waiting for its tailnet approval would spend minutes to fail exactly as
  // the bootstrap already did — and report it as if something else were wrong.
  const tailnet = await projectTailnet(sandbox.projectId);
  if (tailnet?.loginServer && !tailnet.hasAuthKey && !sandbox.tailscaleIp) {
    throw new Error(
      "This sandbox is not on the tailnet yet, and its repos are behind it. Approve the registration first (Refresh Tailscale session), then retry.",
    );
  }

  const { spec } = await buildSpec(
    sandbox.projectId,
    sandbox.name,
    sandbox.provider as SandboxProvider,
  );
  const repos = spec.repos.filter((r) => r.repoUrl || r.mountPath);
  if (repos.length === 0) {
    throw new Error("This project has no repositories to set up.");
  }

  // Root: the script chowns /opt/nexus and drops to the agent user itself.
  const res = await execRemote(renderRepoSetup(repos), {
    ...sandboxTarget(sandbox, "/", "root"),
    // Install and build are the slow half, and a cold npm/pnpm install on a
    // fresh box is minutes, not seconds.
    timeoutMs: 20 * 60_000,
  });
  const log = `${res.stdout}\n${res.stderr}`.trim();

  // Read the structured report the steps just appended, rather than scraping
  // the log for `[nexux] WARN: … failed for <name>` (spec 24 piece 1). The
  // regex only ever matched clone/install/build, so a failed stack `up` or a
  // failed launcher was invisible here and the retry reported success while
  // the sandbox was still missing its database.
  //
  // The log stays the fallback: an older sandbox — provisioned before the
  // recorder existed — has no report file, and its WARNs are all there is.
  let failed: string[];
  try {
    const out = await execRemote(bootstrapReportCommand(), {
      ...sandboxTarget(sandbox, "/", "root"),
      timeoutMs: 30_000,
    });
    const report = parseBootstrapReport(out.stdout);
    failed = report.steps.length
      ? failedSteps(report).map((s) => s.step)
      : scrapeFailuresFromLog(log);
  } catch {
    failed = scrapeFailuresFromLog(log);
  }

  return { ok: failed.length === 0, failed: [...new Set(failed)], log };
}

async function getLegacyAwsCredentials(): Promise<{
  accessKeyId: string;
  secretAccessKey: string;
} | null> {
  const settings = await prisma.settings.findMany({
    where: {
      isActive: true,
      key: { in: ["aws_access_key_id", "aws_secret_access_key"] },
    },
  });
  const accessKeyId =
    settings.find((s) => s.key === "aws_access_key_id")?.value ??
    process.env.AWS_ACCESS_KEY_ID ??
    null;
  const secretAccessKey =
    settings.find((s) => s.key === "aws_secret_access_key")?.value ??
    process.env.AWS_SECRET_ACCESS_KEY ??
    null;
  if (!accessKeyId || !secretAccessKey) return null;
  return { accessKeyId, secretAccessKey };
}

// Shape of CloudCredential.data — civo: {token}, aws: {accessKeyId, secretAccessKey}
type CredentialData = {
  token?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  /**
   * Container registry this token logs in to, when it is not the provider's
   * public one — a self-hosted GitLab or GitHub Enterprise serves its registry
   * on the install's own domain.
   */
  registryHost?: string;
};

function credentialEnv(
  provider: string,
  data: unknown,
): ProviderCredentials | null {
  const d = (data ?? {}) as CredentialData;
  if (provider === "aws") {
    return d.accessKeyId && d.secretAccessKey
      ? {
          AWS_ACCESS_KEY_ID: d.accessKeyId,
          AWS_SECRET_ACCESS_KEY: d.secretAccessKey,
        }
      : null;
  }
  return d.token ? { CIVO_TOKEN: d.token } : null;
}

async function legacyCredentials(
  provider: string,
): Promise<ProviderCredentials | null> {
  if (provider === "aws") {
    const creds = await getLegacyAwsCredentials();
    return creds
      ? {
          AWS_ACCESS_KEY_ID: creds.accessKeyId,
          AWS_SECRET_ACCESS_KEY: creds.secretAccessKey,
        }
      : null;
  }
  const token = await getCivoToken();
  return token ? { CIVO_TOKEN: token } : null;
}

/**
 * Env vars the terraform process needs to authenticate with the provider.
 * Resolution order: the requested saved credential → the oldest saved
 * credential for the provider → legacy Settings rows / process env.
 */
export async function resolveProviderCredentials(
  provider: string,
  credentialId?: string | null,
): Promise<{ env: ProviderCredentials; credentialId: string | null } | null> {
  if (credentialId) {
    const cred = await prisma.cloudCredential.findUnique({
      where: { id: credentialId },
    });
    // Wrong-provider or deleted references fall through to the defaults.
    if (cred && cred.provider === provider) {
      const env = credentialEnv(provider, cred.data);
      if (env) return { env, credentialId: cred.id };
    }
  }
  const first = await prisma.cloudCredential.findFirst({
    where: { provider },
    orderBy: { createdAt: "asc" },
  });
  if (first) {
    const env = credentialEnv(provider, first.data);
    if (env) return { env, credentialId: first.id };
  }
  const legacy = await legacyCredentials(provider);
  return legacy ? { env: legacy, credentialId: null } : null;
}

const GIT_PROVIDERS = ["github", "gitlab", "bitbucket"] as const;

/** Env var each git provider's token is exposed as on the instance. */
export const GIT_TOKEN_ENV: Record<string, string> = {
  github: "GITHUB_TOKEN",
  gitlab: "GITLAB_TOKEN",
  bitbucket: "BITBUCKET_TOKEN",
};

/**
 * Saved git-hosting token to inject at launch: the selected credential, else
 * the oldest saved git credential of any provider. Credentials are global —
 * never scoped by workspace. A project-level env var with the same name
 * always wins (handled by the caller).
 *
 * `opts.provider` narrows the fallback to one host. A sandbox wants any token
 * (it exports all of them as `GITHUB_TOKEN`/`GITLAB_TOKEN`/…), but a clone
 * needs the token for *this* remote: taking the oldest credential of any
 * provider and then discarding it for not matching means a saved GitHub token
 * goes unused whenever a GitLab one happens to be older, and the clone falls
 * back to anonymous against a private repo.
 */
export async function resolveGitCredential(
  credentialId?: string | null,
  opts: { provider?: string } = {},
): Promise<{
  id: string;
  provider: string;
  token: string;
  name: string;
  /** Registry override saved on the credential, if any. */
  registryHost?: string | null;
} | null> {
  if (credentialId) {
    const cred = await prisma.cloudCredential.findUnique({
      where: { id: credentialId },
    });
    if (cred && (GIT_PROVIDERS as readonly string[]).includes(cred.provider)) {
      const data = cred.data as CredentialData | null;
      if (data?.token) {
        return {
          id: cred.id,
          provider: cred.provider,
          token: data.token,
          name: cred.name,
          registryHost: data.registryHost ?? null,
        };
      }
    }
  }
  const providers =
    opts.provider && (GIT_PROVIDERS as readonly string[]).includes(opts.provider)
      ? [opts.provider]
      : [...GIT_PROVIDERS];

  // Every candidate, not just the oldest row: a secretless import leaves
  // credential *shells* with no token behind, and picking the oldest row
  // blindly would return one of those while a usable token sat in the next.
  const candidates = await prisma.cloudCredential.findMany({
    where: { provider: { in: providers } },
    orderBy: { createdAt: "asc" },
  });

  for (const cred of candidates) {
    const data = cred.data as CredentialData | null;
    if (!data?.token) continue;
    return {
      id: cred.id,
      provider: cred.provider,
      token: data.token,
      name: cred.name,
      registryHost: data.registryHost ?? null,
    };
  }
  return null;
}

/** One git token a launch will put on the instance. */
export type GitTokenInjection = {
  provider: GitProvider;
  /** GITHUB_TOKEN / GITLAB_TOKEN / BITBUCKET_TOKEN. */
  envKey: string;
  token: string;
  credentialName: string;
  /** The self-hosted instance this token also authenticates, if any. */
  gitlabHost: string | null;
  /**
   * Set when this provider's repos name different credentials: the sandbox
   * gets one token per provider, so one of them wins and this says which.
   */
  conflict: string | null;
};

/** A repo as far as its git token goes. */
export type GitTokenRepo = {
  name?: string;
  repoUrl?: string | null;
  gitCredentialId?: string | null;
};

/**
 * Every git token a launch injects — one per host the project's repos declare,
 * plus the selected credential even when no repo names its host (a project of
 * empty repo shells has nothing to derive from).
 *
 * Shared with the settings panel rather than reimplemented there. The panel
 * exists so that nothing reaching the sandbox env is invisible in it, and it
 * used to resolve only the single selected credential — which silently stopped
 * being the whole story the moment injection became host-scoped.
 */
export async function resolveGitTokens(
  repos: GitTokenRepo[],
  selectedCredentialId?: string | null,
): Promise<GitTokenInjection[]> {
  const selected = await resolveGitCredential(selectedCredentialId);
  const repoUrls = repos.map((r) => r.repoUrl);
  const needed = gitProvidersForRepos(repoUrls);
  if (selected) needed.add(selected.provider as GitProvider);

  const tokens: GitTokenInjection[] = [];
  for (const provider of needed) {
    const envKey = GIT_TOKEN_ENV[provider];
    if (!envKey) continue;
    // The credential on the repo card is the one the user picked for that
    // repo, and the one Sync on this machine already clones with — a sandbox
    // ignoring it cloned with a different, possibly dead, token while the card
    // showed a working one. The sandbox's own "Git token" is the fallback for
    // repos that name none.
    const fromRepos = await repoCredentialsFor(provider, repos);
    const winner = fromRepos[0];
    const cred =
      winner?.cred ??
      (selected?.provider === provider
        ? selected
        : await resolveGitCredential(null, { provider }));
    if (!cred) continue;
    tokens.push({
      provider,
      envKey,
      token: cred.token,
      credentialName: cred.name,
      // A GitLab token only authenticates gitlab.com unless GITLAB_HOST names
      // the instance; the repos already say where they live.
      gitlabHost:
        provider === "gitlab"
          ? selfHostedGitLabHost(repoUrls, cred.registryHost)
          : null,
      conflict:
        fromRepos.length > 1
          ? `${provider} repos use different tokens (${fromRepos
              .map((c) => `${c.cred.name}: ${c.repos.join(", ")}`)
              .join("; ")}); the sandbox gets one ${envKey} — ${winner.cred.name}`
          : null,
    });
  }
  // Stable order so the settings panel does not reshuffle between loads.
  return tokens.sort((a, b) => a.envKey.localeCompare(b.envKey));
}

/**
 * The usable credentials this provider's repos name, most-used first (ties
 * keep repo order, so the main repo — listed first — decides). A credential
 * that is gone or belongs to another provider is skipped, not fatal.
 */
async function repoCredentialsFor(provider: GitProvider, repos: GitTokenRepo[]) {
  const byId = new Map<string, string[]>();
  for (const r of repos) {
    if (!r.gitCredentialId || gitProviderOfUrl(r.repoUrl) !== provider) continue;
    byId.set(r.gitCredentialId, [...(byId.get(r.gitCredentialId) ?? []), r.name ?? r.repoUrl ?? "?"]);
  }
  const found: Array<{ cred: NonNullable<Awaited<ReturnType<typeof resolveGitCredential>>>; repos: string[] }> = [];
  for (const [id, names] of byId) {
    const cred = await resolveGitCredential(id);
    // resolveGitCredential falls back to any credential when the id is gone;
    // only the one actually named counts here.
    if (cred?.id === id && cred.provider === provider) found.push({ cred, repos: names });
  }
  return found.sort((a, b) => b.repos.length - a.repos.length);
}

export async function getSandboxReadiness() {
  const [
    terraformInstalled,
    dockerInstalled,
    savedCreds,
    civoLegacy,
    awsLegacy,
    claudeToken,
  ] = await Promise.all([
    terraformAvailable(),
    dockerAvailable(),
    prisma.cloudCredential.groupBy({ by: ["provider"], _count: true }),
    getCivoToken(),
    getLegacyAwsCredentials(),
    getLegacyClaudeCodeToken(),
  ]);
  const saved = new Set(savedCreds.map((c) => c.provider));
  return {
    terraformInstalled,
    dockerInstalled,
    hasCivoToken: saved.has("civo") || Boolean(civoLegacy),
    hasAwsCredentials: saved.has("aws") || Boolean(awsLegacy),
    hasClaudeCodeToken: saved.has("claude") || Boolean(claudeToken),
  };
}

function envVarsToRecord(
  vars: Array<{ key: string; value: string }>,
): Record<string, string> {
  return Object.fromEntries(vars.map((v) => [v.key, v.value]));
}

async function buildSpec(
  projectId: string,
  instanceName: string,
  provider: SandboxProvider,
): Promise<{ spec: SandboxSpec; stack: SandboxStackCompose }> {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    include: {
      repositories: { include: { setup: true, envVars: true } },
      envVars: { where: { repositoryId: null } },
      sandboxConfig: {
        include: { llmCredentials: { include: { credential: true } } },
      },
    },
  });
  if (!project) throw new Error("Project not found");

  const cfg = project.sandboxConfig ?? {
    ...SANDBOX_CONFIG_DEFAULTS,
    llmCredentials: [],
  };

  // What the Stack canvas already knows about this project: which port the app
  // serves, whether anything needs Docker, and which local nodes are launchers
  // that bring up their own containers.
  const inherited = await getStackInheritance(projectId);
  const previewPort = cfg.previewPort ?? inherited.previewPort ?? 3000;
  const stackFor = (repositoryId: string) =>
    inherited.repoCommands.find((c) => c.repositoryId === repositoryId) ?? null;

  // Stack tab docker services come up on the instance before repos install.
  const stack: SandboxStackCompose = cfg.includeStackServices
    ? await buildSandboxStackCompose(projectId, { previewPort })
    : { yaml: "", services: [], warnings: [] };

  const envVars = envVarsToRecord(project.envVars);
  // Saved git credentials fill their provider's token env var (GITHUB_TOKEN,
  // GITLAB_TOKEN, ...) unless the project defines it explicitly.
  //
  // One token per host the project's repos actually live on, rather than the
  // single selected credential: a project split across a self-hosted GitLab
  // and github.com used to get whichever provider was selected and clone the
  // other host anonymously, failing as `could not read Username` — with the
  // bootstrap still reporting success. Scoping to the declared repo hosts
  // fixes that without handing every sandbox every token it owns.
  const repoUrls = project.repositories.map((r) => r.repoUrl);
  // Picked over every repo, exactly as resolveWorkDir does — deliberately not
  // over the provisioned subset. A cloud sandbox drops URL-less repos, and
  // marking the next repo "main" there would guard a checkout no task ever
  // uses while the real one stayed silently absent.
  const mainRepo = pickMainRepo(project.repositories);

  for (const git of await resolveGitTokens(
    // Main repo first: it breaks a tie between repos naming different tokens.
    [mainRepo, ...project.repositories.filter((r) => r !== mainRepo)].filter(
      (r): r is NonNullable<typeof r> => !!r,
    ),
    cfg.githubCredentialId,
  )) {
    if (!envVars[git.envKey]) envVars[git.envKey] = git.token;
    // Without GITLAB_HOST a self-hosted clone carries no credential at all and
    // fails as `could not read Username for 'https://…'` — an error that blames
    // the prompt, not the missing config.
    if (git.gitlabHost && !envVars.GITLAB_HOST) {
      envVars.GITLAB_HOST = git.gitlabHost;
    }
  }
  // Selected Claude Code token (Settings → AI Providers) unless the project
  // defines its own env var.
  if (!envVars.CLAUDE_CODE_OAUTH_TOKEN) {
    const claude = await resolveClaudeCodeToken(cfg.claudeCredentialId);
    if (claude) envVars.CLAUDE_CODE_OAUTH_TOKEN = claude.token;
  }
  if (stack.services.length > 0) {
    // Discovery hint for agent tasks: "postgres:5432,redis:6379".
    envVars.NEXUX_STACK_SERVICES = stack.services
      .map((s) => (s.ports[0] ? `${s.name}:${s.ports[0].host}` : s.name))
      .join(",");
  }

  // Selected LLM provider credentials (OpenCode brain) — explicit choices,
  // applied before the global fallback so they win over Settings keys.
  applyLlmCredentials(
    envVars,
    cfg.llmCredentials.map((link) => ({
      provider: link.credential.provider,
      apiKey: (link.credential.data as { apiKey?: string } | null)?.apiKey,
    })),
  );

  // Global Settings secrets flow into every sandbox — allowlisted only
  // (merge rules live with @nexux/sandbox applyGlobalSecrets + its tests).
  // Resolution is workspace-scoped with default-workspace fallback.
  const globalSecrets = (
    await Promise.all(
      Object.keys(GLOBAL_ENV_SETTINGS).map(async (key) => {
        const row = await getWorkspaceSetting(project.workspaceId, key);
        return row ? { key, value: row.value } : null;
      }),
    )
  ).filter((r): r is { key: string; value: string } => r !== null);
  applyGlobalSecrets(envVars, globalSecrets);

  // Nexus's own keypair goes in via terraform so the in-app terminal is
  // authenticated from the first boot; the user's key (if any) is appended
  // to authorized_keys by the bootstrap.
  const keypair = ensureSandboxKeypair(getConfig().dataDir);

  const tailscale = cfg.installTailscale
    ? await resolveTailscaleKey(cfg.tailscaleCredentialId)
    : null;

  const spec: SandboxSpec = {
    provider: (cfg.provider === "aws" ? "aws" : "civo") as SandboxProvider,
    name: instanceName,
    region: cfg.region,
    size: cfg.size,
    diskImage: cfg.diskImage,
    sshPublicKey: keypair.publicKey,
    authorizedKeys: cfg.sshPublicKey ? [cfg.sshPublicKey] : [],
    // The canvas can require Docker even when the toggle is off: a docker node
    // or a launcher node cannot run without it.
    installDocker: cfg.installDocker || inherited.needsDocker,
    installNode: cfg.installNode,
    installClaudeCode: cfg.installClaudeCode,
    // The OpenCode brain is useless without its CLI — force the install on.
    installOpenCode: cfg.installOpenCode || cfg.brain === "opencode",
    openCodeModel: cfg.openCodeModel,
    claudeModel: cfg.claudeModel,
    installAgentBrowser: cfg.installAgentBrowser,
    installCloudflared: cfg.installCloudflared,
    // The session runs Chromium from installAgentBrowser, so asking for a
    // browser without one would install a display serving nothing.
    installBrowserSession:
      cfg.installBrowserSession && cfg.installAgentBrowser,
    installTailscale: cfg.installTailscale,
    // Without a key the bootstrap registers interactively and prints the URL
    // to approve, so a missing or keyless credential never blocks a launch.
    tailscaleAuthKey: tailscale?.authKey ?? null,
    tailscaleLoginServer: tailscale?.loginServer ?? null,
    setupScript: cfg.setupScript,
    mcpServers: (cfg.mcpServers as Record<string, unknown> | null) ?? null,
    stackComposeYaml: stack.yaml || null,
    stackServiceNames: stack.services.map((s) => s.name),
    // Launchers only make sense once their checkout exists, so they ride in
    // the bootstrap rather than the compose file. Nodes without a repo have
    // nowhere to run on the instance and are dropped.
    stackLaunchers: cfg.includeStackServices
      ? inherited.serviceLaunchers
          .filter((l) => l.repoName)
          .map((l) => ({
            name: l.name,
            repoDir: safeSlug(l.repoName!),
            workdir: l.workdir,
            startCommand: l.startCommand,
          }))
      : [],
    envVars,
    repos: project.repositories
      // URL-less repos ride along on local sandboxes only: their local
      // folder is bind-mounted into the container (no git remote needed).
      .filter((r) => r.repoUrl || (provider === "local" && r.localPath))
      .map((r) => ({
        name: r.name,
        repoUrl: r.repoUrl,
        mountPath: r.repoUrl ? null : r.localPath,
        // Marked from the same picker resolveWorkDir uses, so the repo the
        // bootstrap refuses to start without is exactly the one tasks cd into.
        isMain: mainRepo?.id === r.id,
        // Per-repo branch wins; the project-wide base branch is the fallback.
        branch: r.setup?.branch?.trim() || cfg.branch,
        // Empty commands inherit the repo's stack node — the canvas knows how
        // this repo installs, builds and boots; the generic defaults do not.
        installCommand:
          r.setup?.installCommand?.trim() ||
          stackFor(r.id)?.installCommand ||
          r.setup?.installCommand,
        buildCommand:
          r.setup?.buildCommand?.trim() ||
          stackFor(r.id)?.buildCommand ||
          r.setup?.buildCommand,
        runCommand:
          r.setup?.runCommand?.trim() ||
          stackFor(r.id)?.runCommand ||
          r.setup?.runCommand,
        // Only the canvas knows this — there is no per-repo port in
        // RepositorySetup. The main repo falls back to the resolved preview
        // port, which is the same number the UI previews and the user's own
        // Start waits on, so a green probe means the Start will work too.
        runPort:
          stackFor(r.id)?.runPort ??
          (mainRepo?.id === r.id ? previewPort : null),
        envVars: envVarsToRecord(r.envVars),
      })),
  };

  return { spec, stack };
}

// Buffers terraform output in memory and flushes it to Sandbox.log at most
// once per second, so log streaming doesn't hammer SQLite.
function createLogWriter(sandboxId: string) {
  let full = "";
  let timer: NodeJS.Timeout | null = null;
  let writing = Promise.resolve();

  const flush = () => {
    timer = null;
    const snapshot = full;
    writing = writing.then(() =>
      prisma.sandbox
        .update({ where: { id: sandboxId }, data: { log: snapshot } })
        .then(() => undefined)
        .catch(() => undefined),
    );
  };

  return {
    sink(chunk: string) {
      full += chunk;
      if (!timer) timer = setTimeout(flush, 1000);
    },
    append(line: string) {
      this.sink(line.endsWith("\n") ? line : line + "\n");
    },
    async close() {
      if (timer) clearTimeout(timer);
      flush();
      await writing;
    },
  };
}

/**
 * Resolve the instance name for a new sandbox, refusing one already in use.
 *
 * Two places can hold a name and both matter. Our own rows are the obvious
 * one, but only those still alive: a destroyed sandbox keeps its row for its
 * task history, and burning its name forever would mean a project could never
 * reuse the good short names it just freed. The host is the other — a docker
 * container owns its name whether running or stopped, and can outlive the row
 * that made it, so a DB-only check would pass and `docker run` would then fail
 * with a conflict the user never asked about.
 */
/** Which project already holds this name, or null when it is free. */
async function projectHoldingName(name: string): Promise<string | null> {
  const taken = await prisma.sandbox.findFirst({
    where: { name, status: { not: "destroyed" } },
    select: { project: { select: { name: true } } },
  });
  return taken?.project.name ?? null;
}

export type SandboxNameLookups = {
  /** Project name holding it among live sandboxes, or null. */
  heldBy: (name: string) => Promise<string | null>;
  /** Does the host already have a container by this name, any state? */
  containerExists: (name: string) => Promise<boolean>;
  /** Names the daemon in the collision message; defaults to "this machine". */
  where?: string;
};

export async function resolveSandboxName(
  projectName: string,
  sandboxId: string,
  requested: string | undefined,
  provider: SandboxProvider,
  /** Prefix for the generated form; a chosen name replaces it entirely. */
  prefix: string = DEFAULT_SANDBOX_PREFIX,
  lookups: SandboxNameLookups = {
    heldBy: projectHoldingName,
    containerExists: localContainerExists,
  },
): Promise<string> {
  if (!requested?.trim()) {
    return sandboxInstanceName(projectName, sandboxId, prefix);
  }

  const parsed = customSandboxName(requested);
  if ("error" in parsed) {
    throw new Error(
      parsed.error === "empty"
        ? "That name has no letters or digits to build a name from."
        : `That name is too long — keep it under ${MAX_CUSTOM_NAME_LENGTH} characters.`,
    );
  }
  const { name } = parsed;

  const heldBy = await lookups.heldBy(name);
  if (heldBy) {
    throw new Error(`"${name}" is already used by a sandbox in ${heldBy}.`);
  }

  // Only local sandboxes collide on this machine; a cloud instance name is
  // scoped to the provider, which rejects duplicates itself.
  if (provider === "local" && (await lookups.containerExists(name))) {
    throw new Error(
      `A docker container called "${name}" already exists on ${lookups.where ?? "this machine"}.`,
    );
  }

  return name;
}

/**
 * The daemon a new local sandbox goes to (spec 26): null for this machine,
 * or a DockerEndpoint's id. Resolved here rather than trusted from the caller,
 * so a stale id fails loudly instead of launching on this machine.
 */
async function resolveDockerEndpoint(
  dockerEndpointId: string | null | undefined,
): Promise<{ id: string; name: string; target: DockerTarget } | null> {
  if (!dockerEndpointId) return null;
  const endpoint = await prisma.dockerEndpoint.findUnique({
    where: { id: dockerEndpointId },
  });
  if (!endpoint) throw new Error("That Docker endpoint no longer exists.");
  return { id: endpoint.id, name: endpoint.name, target: { host: endpoint.host } };
}

/** Where a local sandbox's container lives, off its row. */
function rowTarget(sandbox: { dockerHost: string | null }): DockerTarget {
  return { host: sandbox.dockerHost };
}

export async function launchSandbox(
  projectId: string,
  providerOverride?: SandboxProvider,
  requestedName?: string,
  /**
   * Which machine's Docker, for a local sandbox. `undefined` = the project's
   * saved choice (so a scheduled launch lands where the user set it); `null`
   * = this machine, explicitly.
   */
  dockerEndpointId?: string | null,
): Promise<Sandbox> {
  const [readiness, project] = await Promise.all([
    getSandboxReadiness(),
    prisma.project.findUnique({
      where: { id: projectId },
      include: { repositories: true, sandboxConfig: true },
    }),
  ]);
  if (!project) throw new Error("Project not found");

  const configProvider = project.sandboxConfig?.provider;
  const provider: SandboxProvider =
    providerOverride ??
    (configProvider === "aws" || configProvider === "local"
      ? configProvider
      : "civo");

  if (dockerEndpointId && provider !== "local") {
    throw new Error("A Docker endpoint only applies to local sandboxes.");
  }
  const endpoint = await resolveDockerEndpoint(
    dockerEndpointId !== undefined
      ? dockerEndpointId
      : provider === "local"
        ? (project.sandboxConfig?.dockerEndpointId ?? null)
        : null,
  );
  const target: DockerTarget = endpoint?.target ?? { host: null };

  // A bind mount names a path on the daemon's disk. Another machine cannot see
  // this one's folders — Docker would mount an empty directory without a word
  // — so refuse, naming the repos, rather than drop them or guess a path.
  if (endpoint) {
    const mountOnly = project.repositories.filter((r) => !r.repoUrl && r.localPath);
    if (mountOnly.length > 0) {
      throw new Error(
        `"${endpoint.name}" can't see local folders: ${mountOnly.map((r) => r.name).join(", ")}. Give ${mountOnly.length === 1 ? "it" : "them"} a clone URL, or run the sandbox on this machine.`,
      );
    }
  }

  // Cloud credentials only matter for cloud providers; local needs Docker.
  let resolved: { credentialId: string | null; env: ProviderCredentials } | null =
    null;
  if (provider === "local") {
    if (!(await dockerAvailable(target))) {
      throw new Error(
        endpoint
          ? `Docker on "${endpoint.name}" isn't answering — check it in Settings → Cloud → Docker endpoints.`
          : "Docker is not available. Local sandboxes run in a Docker container — start Docker Desktop and retry.",
      );
    }
  } else {
    if (!readiness.terraformInstalled) {
      throw new Error(
        "terraform CLI not found. Install it from developer.hashicorp.com/terraform and restart Nexus.",
      );
    }
    resolved = await resolveProviderCredentials(
      provider,
      project.sandboxConfig?.credentialId,
    );
    if (!resolved) {
      throw new Error(
        provider === "aws"
          ? "No AWS credential found. Save one in the sandbox settings before launching."
          : "No Civo credential found. Save one in the sandbox settings before launching.",
      );
    }
  }
  // Cloud sandboxes clone by URL; local sandboxes can also bind-mount repos
  // that only have a local folder (e.g. bootstrap projects with no remote).
  const hasCloneable = project.repositories.some((r) => r.repoUrl);
  const hasMountable = project.repositories.some((r) => r.localPath);
  if (provider === "local" ? !hasCloneable && !hasMountable : !hasCloneable) {
    throw new Error(
      provider === "local"
        ? "No repositories to load. Add a repo URL or a local path before launching a sandbox."
        : "No repositories with a clone URL. Cloud sandboxes clone by URL — add repository URLs, or launch a local sandbox to work on local folders directly.",
    );
  }

  // Required so every sandbox can clone private repos and run Claude Code
  // headlessly from the first boot. Both come from global config (saved git
  // credential / Settings token); a project env var with the same key wins.
  const tokens = await prisma.projectEnvVar.findMany({
    where: {
      projectId,
      repositoryId: null,
      key: { in: ["GITHUB_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"] },
    },
    select: { key: true },
  });
  const missing: string[] = [];
  if (
    hasCloneable && // mounted-only sandboxes have nothing to clone or push
    !tokens.some((t) => t.key === "GITHUB_TOKEN") &&
    !(await resolveGitCredential(project.sandboxConfig?.githubCredentialId))
  ) {
    missing.push("git token (Settings → Git, or a GITHUB_TOKEN project env var)");
  }
  if (
    !tokens.some((t) => t.key === "CLAUDE_CODE_OAUTH_TOKEN") &&
    !(await resolveClaudeCodeToken(project.sandboxConfig?.claudeCredentialId))
  ) {
    missing.push(
      "Claude Code token (Settings → AI Providers, or a CLAUDE_CODE_OAUTH_TOKEN project env var)",
    );
  }
  if (missing.length > 0) {
    throw new Error(`Missing: ${missing.join("; ")}. Set before launching.`);
  }

  const sandboxId = randomUUID();
  const instanceName = await resolveSandboxName(
    project.name,
    sandboxId,
    requestedName,
    provider,
    await sandboxPrefixForProject(projectId),
    {
      heldBy: projectHoldingName,
      containerExists: (n) => localContainerExists(n, target),
      where: endpoint ? `"${endpoint.name}"` : undefined,
    },
  );
  const workDir = path.join(getConfig().dataDir, "sandboxes", sandboxId);

  const { spec, stack } = await buildSpec(projectId, instanceName, provider);

  const sandbox = await prisma.sandbox.create({
    data: {
      id: sandboxId,
      projectId,
      name: instanceName,
      status: "provisioning",
      provider,
      credentialId: resolved?.credentialId ?? null,
      // The row's "@ where" — for a remote daemon, the endpoint's name.
      region: provider === "local" ? (endpoint?.name ?? "local") : spec.region,
      size: provider === "local" ? "docker" : spec.size,
      stackServices: stack.services,
      workDir,
      dockerEndpointId: endpoint?.id ?? null,
      dockerHost: target.host,
    },
  });

  const stackLog: string[] = [];
  if (stack.services.length > 0) {
    stackLog.push(
      `[nexux] stack services: ${stack.services.map((s) => s.name).join(", ")}`,
    );
    if (!spec.installDocker) {
      stackLog.push(
        `[nexux] stack: docker install is disabled — ${stack.services.length} service${stack.services.length !== 1 ? "s" : ""} will be skipped`,
      );
    }
  }
  stackLog.push(...stack.warnings.map((w) => `[nexux] stack: ${w}`));

  activeOps.add(sandboxId);
  const provision =
    provider === "local"
      ? runLocalProvision(sandboxId, spec, stackLog, target)
      : runProvision(sandboxId, workDir, spec, resolved!.env, stackLog);
  void provision.finally(() => activeOps.delete(sandboxId));

  return sandbox;
}

/**
 * Local provider: privileged Docker container + the same bootstrap script.
 * "running" is only set once the bootstrap marker exists — unlike Civo, where
 * terraform returning means the bootstrap is still going, docker exec makes
 * it cheap to wait for actual readiness.
 */
async function runLocalProvision(
  sandboxId: string,
  spec: SandboxSpec,
  extraLogLines: string[] = [],
  target: DockerTarget = { host: null },
) {
  const log = createLogWriter(sandboxId);
  try {
    log.append(
      `[nexux] provisioning local container ${spec.name}${target.host ? ` on ${target.host}` : ""}`,
    );
    for (const line of extraLogLines) log.append(line);
    const { containerName } = await launchLocalSandbox({
      name: spec.name,
      spec,
      onLog: log.sink.bind(log),
      // Start from the prebuilt base when one is current (spec 24 piece 3).
      // Never builds inline — an absent or stale base falls back to
      // ubuntu:22.04 and the bootstrap installs what it needs, exactly as
      // before. Building is an explicit action, because a launch that quietly
      // spent five minutes on it would be the same slow surprise this piece
      // exists to remove.
      preferPrebuilt: true,
      target,
    });
    await prisma.sandbox.update({
      where: { id: sandboxId },
      data: { instanceId: containerName },
    });

    const deadline = Date.now() + 20 * 60_000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10_000));
      if (!(await localSandboxRunning(containerName, target))) {
        throw new Error("container exited during bootstrap");
      }
      // Checked before completion: a fatal step suppresses the completion
      // marker, so without this the run only ends at the 20-minute timeout,
      // reporting a deadline instead of the reason sitting on disk.
      const failure = await localBootstrapFailure(containerName, target);
      if (failure) throw new Error(failure);
      if (await localBootstrapComplete(containerName, target)) {
        log.append(`[nexux] bootstrap complete — sandbox ready`);
        await prisma.sandbox.update({
          where: { id: sandboxId },
          data: { status: "running" },
        });
        void notifySandboxStatus(sandboxId).catch(() => undefined);
        return;
      }
    }
    throw new Error("bootstrap did not finish within 20 minutes");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.append(`[nexux] ERROR: ${message}`);
    await prisma.sandbox
      .update({
        where: { id: sandboxId },
        data: { status: "error", error: message },
      })
      .catch(() => undefined);
    void notifySandboxStatus(sandboxId).catch(() => undefined);
  } finally {
    await log.close();
  }
}

/**
 * Read the bootstrap's verdict off a cloud instance once it is reachable.
 *
 * A cloud sandbox goes `running` the moment terraform returns, because the box
 * genuinely is usable then — logs, terminal and VS Code all work while the
 * bootstrap runs. The cost was that nobody ever read how the bootstrap ended:
 * a run whose main checkout failed to clone stayed `running`, and the first
 * report of it was a task dying on `cd` hours later. This polls the two markers
 * the bootstrap writes and downgrades the row when the verdict is failure.
 *
 * Only ever a downgrade: success is already the row's state, so a watch that
 * cannot reach the box (key rotated, instance paused, ssh not up yet) leaves
 * the sandbox exactly as provisioning left it.
 */
async function watchCloudBootstrap(
  sandboxId: string,
  opts: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<void> {
  const deadline = Date.now() + (opts.timeoutMs ?? 30 * 60_000);
  const interval = opts.intervalMs ?? 20_000;

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, interval));

    const sandbox = await prisma.sandbox
      .findUnique({ where: { id: sandboxId } })
      .catch(() => null);
    // Destroyed, paused or already errored while we waited — the row has moved
    // on and this watch has no business overwriting it.
    if (!sandbox || sandbox.status !== "running") return;

    const target = sandboxTarget(sandbox, "/", "root");
    const res = await execRemote(
      `cat ${BOOTSTRAP_FAILED_MARKER} 2>/dev/null && exit 3; test -f ${BOOTSTRAP_COMPLETE_MARKER}`,
      { ...target, timeoutMs: 30_000 },
    ).catch(() => null);
    // Unreachable: ssh may simply not be up yet. Keep waiting rather than
    // calling a healthy box broken.
    if (!res) continue;

    if (res.code === 3) {
      const reason =
        res.stdout.trim() || "the bootstrap reported a fatal step";
      const log = createLogWriter(sandboxId);
      try {
        log.append(`[nexux] ERROR: ${reason}`);
      } finally {
        await log.close();
      }
      await prisma.sandbox
        .update({
          where: { id: sandboxId },
          data: { status: "error", error: reason },
        })
        .catch(() => undefined);
      void notifySandboxStatus(sandboxId).catch(() => undefined);
      return;
    }
    if (res.code === 0) return; // bootstrap completed cleanly
  }
}

async function runProvision(
  sandboxId: string,
  workDir: string,
  spec: SandboxSpec,
  credentials: ProviderCredentials,
  extraLogLines: string[] = [],
) {
  const log = createLogWriter(sandboxId);
  try {
    log.append(
      `[nexux] provisioning ${spec.name} on ${spec.provider} (${spec.size} @ ${spec.region})`,
    );
    for (const line of extraLogLines) log.append(line);
    const outputs = await applySandbox({
      workDir,
      spec,
      credentials,
      onLog: log.sink.bind(log),
    });
    log.append(
      `[nexux] instance ready: ${outputs.publicIp ?? "unknown ip"} — bootstrap continues on the instance (see /var/log/nexus-bootstrap.log)`,
    );
    await prisma.sandbox.update({
      where: { id: sandboxId },
      data: {
        status: "running",
        instanceId: outputs.instanceId ?? null,
        publicIp: outputs.publicIp ?? null,
      },
    });
    void notifySandboxStatus(sandboxId).catch(() => undefined);
    // The box is reachable now — terminals, logs and VS Code all work during
    // bootstrap, which is why the row goes `running` here rather than at the
    // end. But nothing used to read the bootstrap's verdict, so a run that
    // failed its main clone stayed `running` and only surfaced when a task
    // died on `cd`. Watch from here instead of blocking: provisioning is
    // already done, and the watch only ever downgrades.
    void watchCloudBootstrap(sandboxId).catch(() => undefined);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.append(`[nexux] ERROR: ${message}`);
    await prisma.sandbox
      .update({
        where: { id: sandboxId },
        data: { status: "error", error: message },
      })
      .catch(() => undefined);
    void notifySandboxStatus(sandboxId).catch(() => undefined);
  } finally {
    await log.close();
  }
}

/**
 * Server-start sweep: provisioning/destroying is driven by an in-process
 * promise, so any sandbox still in those states at boot lost its driver with
 * the previous process. Mark them errored; ephemeral ones get torn down (the
 * terraform state / container may still exist and keep billing).
 */
export async function recoverOrphanSandboxes(): Promise<void> {
  const orphans = await prisma.sandbox.findMany({
    where: { status: { in: ["provisioning", "destroying"] } },
    select: { id: true, name: true, status: true, ephemeral: true },
  });
  for (const orphan of orphans) {
    if (activeOps.has(orphan.id)) continue; // this process is driving it
    console.log(
      `[sandbox] ${orphan.name} was ${orphan.status} when the server died — marking error`,
    );
    await prisma.sandbox
      .update({
        where: { id: orphan.id },
        data: {
          status: "error",
          error: `${orphan.status} interrupted by a server restart`,
        },
      })
      .catch(() => undefined);
    if (orphan.ephemeral || orphan.status === "destroying") {
      await requestDestroy(orphan.id).catch(() => undefined);
    }
  }
}

export async function requestDestroy(sandboxId: string): Promise<Sandbox> {
  const sandbox = await prisma.sandbox.findUnique({ where: { id: sandboxId } });
  if (!sandbox) throw new Error("Sandbox not found");
  if (sandbox.status === "destroyed" || sandbox.status === "destroying") {
    return sandbox;
  }
  if (activeOps.has(sandboxId)) {
    throw new Error("Sandbox has an operation in progress — wait for it to finish.");
  }
  if (sandbox.provider === "local") {
    const updated = await prisma.sandbox.update({
      where: { id: sandboxId },
      data: { status: "destroying", error: null },
    });
    activeOps.add(sandboxId);
    void runLocalDestroy(sandboxId, sandbox.instanceId, rowTarget(sandbox)).finally(() =>
      activeOps.delete(sandboxId),
    );
    return updated;
  }

  // Destroy with the same account that provisioned when possible.
  const resolved = await resolveProviderCredentials(
    sandbox.provider as SandboxProvider,
    sandbox.credentialId,
  );
  if (!resolved) {
    throw new Error(
      sandbox.provider === "aws"
        ? "No AWS credential found to destroy this sandbox."
        : "No Civo credential found to destroy this sandbox.",
    );
  }

  const updated = await prisma.sandbox.update({
    where: { id: sandboxId },
    data: { status: "destroying", error: null },
  });

  activeOps.add(sandboxId);
  void runDestroy(sandboxId, sandbox.workDir, resolved.env).finally(() =>
    activeOps.delete(sandboxId),
  );

  return updated;
}

async function runLocalDestroy(
  sandboxId: string,
  containerName: string | null,
  target: DockerTarget = { host: null },
) {
  const log = createLogWriter(sandboxId);
  const existing = await prisma.sandbox.findUnique({
    where: { id: sandboxId },
    select: { log: true },
  });
  if (existing?.log) log.sink(existing.log);
  try {
    if (containerName) {
      await destroyLocalSandbox(containerName, log.sink.bind(log), target);
    }
    await prisma.sandbox.update({
      where: { id: sandboxId },
      data: { status: "destroyed", destroyedAt: new Date() },
    });
    log.append(`[nexux] destroyed`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.append(`[nexux] ERROR: ${message}`);
    await prisma.sandbox
      .update({
        where: { id: sandboxId },
        data: { status: "error", error: message },
      })
      .catch(() => undefined);
  } finally {
    await log.close();
  }
}

async function runDestroy(
  sandboxId: string,
  workDir: string,
  credentials: ProviderCredentials,
) {
  const log = createLogWriter(sandboxId);
  // Preserve the provisioning log; destroy output is appended after it.
  const existing = await prisma.sandbox.findUnique({
    where: { id: sandboxId },
    select: { log: true, name: true },
  });
  if (existing?.log) log.sink(existing.log);
  try {
    log.append(`[nexux] destroying sandbox`);
    await destroySandbox({ workDir, credentials, onLog: log.sink.bind(log) });
    // The instance is gone — drop its VS Code Remote-SSH host entry too.
    if (existing?.name) {
      try {
        removeSandboxSshHost(getConfig().dataDir, existing.name);
      } catch {
        // Non-fatal: a stale host alias just stops resolving.
      }
    }
    await prisma.sandbox.update({
      where: { id: sandboxId },
      data: {
        status: "destroyed",
        destroyedAt: new Date(),
        publicIp: null,
        tailscaleIp: null,
      },
    });
    log.append(`[nexux] destroyed`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.append(`[nexux] ERROR: ${message}`);
    await prisma.sandbox
      .update({
        where: { id: sandboxId },
        data: { status: "error", error: message },
      })
      .catch(() => undefined);
  } finally {
    await log.close();
  }
}

export function defaultedConfig(config: SandboxConfig | null) {
  return config ?? SANDBOX_CONFIG_DEFAULTS;
}

/** Docker-only: stop the container, keep everything on disk. */
/**
 * Reconcile local sandboxes whose stored status disagrees with Docker.
 *
 * The status column is only written when *we* pause, resume or destroy. A
 * container that dies on its own — OOM kill, `docker stop` from a terminal, a
 * Docker Desktop restart — leaves the row saying "running" forever. The row is
 * what the UI gates on, so the sandbox showed a Live preview button and no
 * Resume, while every action that actually touches the container failed with
 * "Sandbox is not running".
 *
 * Only `running` rows are checked, and only downgraded to `paused`: a stopped
 * container is exactly what pause produces, and `resumeSandbox` can revive it.
 * Rows we know are mid-flight (pending/provisioning) are left alone — their
 * container legitimately isn't up yet.
 */
export type ReconcileCandidate = {
  id: string;
  name: string;
  instanceId: string | null;
  /** The daemon it lives on; null = this machine (spec 26). */
  dockerHost?: string | null;
};

/**
 * Which of `candidates` are no longer running, given probes for Docker.
 * Pure decision half of `reconcileLocalSandboxStatuses`, split out so the rule
 * is testable without a Docker daemon.
 */
export async function staleRunningSandboxIds(
  candidates: ReconcileCandidate[],
  probes: {
    dockerAvailable: (target: DockerTarget) => Promise<boolean>;
    containerRunning: (container: string, target: DockerTarget) => Promise<boolean>;
  },
): Promise<string[]> {
  if (candidates.length === 0) return [];

  // Per daemon: a laptop's Docker Desktop being down says nothing about the
  // workstation's sandboxes, and the reverse. Docker being unreachable is not
  // evidence the sandboxes died — leave those rows alone rather than marking
  // every one of them paused.
  const byHost = new Map<string | null, ReconcileCandidate[]>();
  for (const c of candidates) {
    const key = c.dockerHost ?? null;
    byHost.set(key, [...(byHost.get(key) ?? []), c]);
  }

  const results = await Promise.all(
    [...byHost].map(async ([host, group]) => {
      const target: DockerTarget = { host };
      if (!(await probes.dockerAvailable(target).catch(() => false))) return [];
      return Promise.all(
        group.map(async (s) => {
          // A probe that throws says nothing about the container; treat only a
          // definite "not running" as stale.
          const running = await probes
            .containerRunning(s.instanceId ?? s.name, target)
            .catch(() => true);
          return running ? null : s.id;
        }),
      );
    }),
  );
  return results.flat().filter((id): id is string => id !== null);
}

export async function reconcileLocalSandboxStatuses(
  projectId: string,
): Promise<void> {
  const candidates = await prisma.sandbox.findMany({
    where: { projectId, archived: false, provider: "local", status: "running" },
    select: { id: true, name: true, instanceId: true, dockerHost: true },
  });

  const stale = await staleRunningSandboxIds(candidates, {
    dockerAvailable: (target) => dockerAvailable(target),
    containerRunning: (name, target) => localSandboxRunning(name, target),
  });
  if (stale.length === 0) return;

  await prisma.sandbox
    .updateMany({ where: { id: { in: stale } }, data: { status: "paused" } })
    .catch(() => undefined);
}

export async function pauseSandbox(sandboxId: string) {
  const sandbox = await prisma.sandbox.findUnique({ where: { id: sandboxId } });
  if (!sandbox) throw new Error("Sandbox not found");
  if (sandbox.provider !== "local") {
    throw new Error("Pause is only available for local Docker sandboxes");
  }
  if (sandbox.status !== "running") {
    throw new Error("Only a running sandbox can be paused");
  }
  const { isSandboxBusy } = await import("./task-manager");
  if (isSandboxBusy(sandboxId)) {
    throw new Error("A task is running on this sandbox — wait for it first");
  }
  await pauseLocalSandbox(sandbox.instanceId ?? sandbox.name, rowTarget(sandbox));
  return prisma.sandbox.update({
    where: { id: sandboxId },
    data: { status: "paused" },
  });
}

/** Docker-only: start the container and revive dockerd + stack services. */
export async function resumeSandbox(sandboxId: string) {
  const sandbox = await prisma.sandbox.findUnique({ where: { id: sandboxId } });
  if (!sandbox) throw new Error("Sandbox not found");
  if (sandbox.provider !== "local") {
    throw new Error("Resume is only available for local Docker sandboxes");
  }
  if (sandbox.status !== "paused") {
    throw new Error("Only a paused sandbox can be resumed");
  }
  await resumeLocalSandbox(sandbox.instanceId ?? sandbox.name, {
    target: rowTarget(sandbox),
  });
  return prisma.sandbox.update({
    where: { id: sandboxId },
    data: { status: "running" },
  });
}
