import type { RepositorySetup, Sandbox, SandboxConfig } from "@nexux/db";

export type RepoWithSetup = {
  id: string;
  name: string;
  repoUrl: string | null;
  localPath: string | null;
  isMain: boolean;
  setup: RepositorySetup | null;
};

export type MaskedEnvVar = {
  id: string;
  key: string;
  repositoryId: string | null;
  valueMasked: string;
};

export type SandboxProvider = "civo" | "aws";

/** Where a sandbox can actually launch: a cloud provider or the local Docker host. */
export type LaunchTarget = SandboxProvider | "local";

/** Git hosting providers — one saved token each, injected at sandbox launch. */
export type GitProvider = "github" | "gitlab" | "bitbucket";

/** LLM provider API keys — injected into sandboxes for the OpenCode brain. */
export type LlmProvider =
  | "openai"
  | "openrouter"
  | "google"
  | "xai-llm"
  | "anthropic-key"
  | "zai";

/** Everything a saved credential can be: compute providers + git tokens +
 * Claude Code OAuth tokens + LLM provider API keys. */
export type CredentialProvider =
  | SandboxProvider
  | GitProvider
  | "claude"
  // Tailscale auth key for Nexus hosts (spec 19). Not a sandbox concern, but
  // it is a saved secret and rides the same credential UI.
  | "tailscale"
  | LlmProvider;

export type SandboxReadiness = {
  terraformInstalled: boolean;
  hasCivoToken: boolean;
  hasAwsCredentials: boolean;
  /** A saved "claude" credential, or the legacy claude_code_oauth_token
   * Settings row. */
  hasClaudeCodeToken: boolean;
};

/** Saved provider credential — secrets never reach the client. */
export type CloudCredentialSummary = {
  id: string;
  name: string;
  provider: CredentialProvider;
  /** Masked identifier (key-id prefix / token tail). Only on /api/credentials. */
  hint?: string;
  /**
   * Container registry this token logs in to, when it is not the git host's
   * public one (a self-hosted GitLab / GitHub Enterprise). Not a secret.
   */
  registryHost?: string | null;
  /**
   * Tailscale coordination server this credential joins, for a self-hosted
   * control plane (Headscale). Null = Tailscale's own. Not a secret.
   */
  loginServer?: string | null;
};

export type NewCredentialInput =
  | {
      provider: "civo" | GitProvider | "claude";
      name: string;
      token: string;
      /** Registry override, for a self-hosted git install (git providers only). */
      registryHost?: string;
    }
  | {
      provider: "tailscale";
      name: string;
      /** Omitted on a self-hosted control plane you cannot mint keys on. */
      authKey?: string;
      /** `--login-server`; omitted for Tailscale's own control plane. */
      loginServer?: string;
    }
  | {
      provider: "aws";
      name: string;
      accessKeyId: string;
      secretAccessKey: string;
    }
  | { provider: LlmProvider; name: string; apiKey: string };

export type StackServiceSummary = {
  name: string;
  image: string | null;
  runMode: string;
};

/** A Stack canvas node carrying env vars, offered as an import source. */
export type StackEnvSource = {
  nodeId: string;
  name: string;
  kind: string;
  repositoryId: string | null;
  vars: Array<{ key: string; valueMasked: string }>;
};

/** Outcome of a bulk import — which keys landed, which were left alone. */
export type EnvImportResult = {
  created: string[];
  updated: string[];
  skipped: string[];
  invalidLines?: Array<{ line: number; text: string }>;
  /** Preset ids whose config no longer holds a value (from-config only). */
  missing?: string[];
};

/**
 * A saved config (credential or global Settings row) offered as a one-click
 * source for a project env var. `id` is opaque — the server resolves it back
 * to the secret, which never reaches the browser.
 */
export type EnvPreset = {
  id: string;
  group: "llm" | "settings" | "claude" | "git";
  key: string;
  label: string;
  valueMasked: string;
};

/**
 * Secret that flows into every sandbox launch: an allowlisted Settings key
 * or a saved-credential token (GITHUB_TOKEN, CLAUDE_CODE_OAUTH_TOKEN).
 */
export type GlobalEnvVar = {
  key: string;
  valueMasked: string;
  applied: boolean;
  reason: string | null;
  source?: "settings" | "credential";
  credentialName?: string | null;
};

export type ProjectSetupData = {
  config: SandboxConfig & { llmCredentialIds?: string[] };
  repositories: RepoWithSetup[];
  envVars: MaskedEnvVar[];
  globalEnvVars: GlobalEnvVar[];
  readiness: SandboxReadiness;
  stack: { services: StackServiceSummary[]; envSources?: StackEnvSource[] };
  credentials: CloudCredentialSummary[];
};

export type SandboxConfigInput = {
  provider: SandboxProvider;
  credentialId?: string | null;
  githubCredentialId?: string | null;
  claudeCredentialId?: string | null;
  region: string;
  size: string;
  diskImage: string;
  branch?: string | null;
  sshPublicKey?: string | null;
  installDocker: boolean;
  installNode: boolean;
  installClaudeCode: boolean;
  installOpenCode?: boolean;
  installAgentBrowser: boolean;
  installCloudflared: boolean;
  /** Install tailscale and join the tailnet with the saved auth key. */
  installTailscale?: boolean;
  /** Saved "tailscale" credential; null = the first saved one. */
  tailscaleCredentialId?: string | null;
  includeStackServices: boolean;
  telegramChatId?: string | null;
  slackChannelId?: string | null;
  /** Cap on one agent run in minutes; null = 45. */
  taskTimeoutMinutes?: number | null;
  setupScript?: string | null;
  /** Claude Code MCP servers (native mcpServers shape); null clears them. */
  mcpServers?: Record<string, Record<string, unknown>> | null;
  agentInstructions?: string | null;
  createPr: boolean;
  runTests: boolean;
  captureScreenshots: boolean;
  livePreview: boolean;
  /** null = inherit the port from the Stack canvas. */
  previewPort: number | null;
  claudeModel: string | null;
  /** Which agent CLI runs delegated work on this project's sandboxes. */
  brain: "claude" | "opencode";
  /** opencode -m "provider/model"; null = CLI default. */
  openCodeModel: string | null;
  /** Saved LLM credential ids whose API keys are injected at launch. */
  llmCredentialIds?: string[];
};

export type RepoSetupInput = {
  repositoryId: string;
  installCommand?: string | null;
  buildCommand?: string | null;
  runCommand?: string | null;
  /** Clone this repo at a specific branch; null = the project base branch. */
  branch?: string | null;
};

export type SandboxSummary = Omit<Sandbox, "log" | "workDir" | "projectId"> & {
  /**
   * Ready-to-paste shell command for an external terminal — `ssh -i <this
   * install's key> …` for a cloud sandbox, `docker exec …` for a local one.
   * Composed by the list route (only the server knows the key path); null when
   * the machine has no address yet. Absent on responses from other routes.
   */
  sshCommand?: string | null;
  /**
   * The tailnet this project's sandboxes join, or null when they join none.
   * Set by the list route; what decides whether the row offers to re-run the
   * registration.
   */
  tailnet?: { loginServer: string | null; hasAuthKey: boolean } | null;
};

/** Result of re-running the tailnet join on a live sandbox. */
export type TailscaleLoginResult = {
  /** URL a human has to approve, or null when nothing is pending. */
  authUrl: string | null;
  message: string;
};

/** Outcome of re-running the repo half of the bootstrap. */
export type RetrySetupResult = {
  ok: boolean;
  /** Repos that still failed to clone, install or build. */
  failed: string[];
  log: string;
};

export async function retrySandboxSetup(
  projectId: string,
  sandboxId: string,
): Promise<RetrySetupResult> {
  const res = await fetch(
    `/api/projects/${projectId}/sandboxes/${sandboxId}/retry-setup`,
    { method: "POST" },
  );
  if (!res.ok) return parseError(res, "Retry failed");
  return res.json();
}

export async function refreshTailscaleLogin(
  projectId: string,
  sandboxId: string,
): Promise<TailscaleLoginResult> {
  const res = await fetch(
    `/api/projects/${projectId}/sandboxes/${sandboxId}/tailscale-login`,
    { method: "POST" },
  );
  if (!res.ok) return parseError(res, "Tailscale login failed");
  return res.json();
}

export type SandboxStackService = {
  name: string;
  image: string;
  ports: { host: number; container: number }[];
};

/** Narrow the Sandbox.stackServices Json snapshot into a typed array. */
export function parseStackServices(value: unknown): SandboxStackService[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (s): s is SandboxStackService =>
      typeof s === "object" &&
      s !== null &&
      typeof (s as SandboxStackService).name === "string" &&
      typeof (s as SandboxStackService).image === "string",
  );
}

/**
 * An API error that also carries the server-side log tail, so the UI can show
 * *why* something failed instead of only that it did.
 */
export class ApiError extends Error {
  readonly log?: string;
  constructor(message: string, log?: string) {
    super(message);
    this.name = "ApiError";
    this.log = log;
  }
}

async function parseError(res: Response, fallback: string): Promise<never> {
  const body = await res.json().catch(() => ({}) as { error?: unknown });
  const err = (body as { error?: unknown }).error;
  const log = (body as { log?: unknown }).log;
  throw new ApiError(
    typeof err === "string" ? err : fallback,
    typeof log === "string" && log.trim() ? log.trim() : undefined,
  );
}

export async function getProjectSetup(
  projectId: string,
): Promise<ProjectSetupData> {
  const res = await fetch(`/api/projects/${projectId}/setup`);
  if (!res.ok) return parseError(res, "Failed to load project setup");
  return res.json();
}

export async function saveProjectSetup(
  projectId: string,
  data: { config?: SandboxConfigInput; repoSetups?: RepoSetupInput[] },
): Promise<void> {
  const res = await fetch(`/api/projects/${projectId}/setup`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  if (!res.ok) return parseError(res, "Failed to save project setup");
}

export async function addEnvVar(
  projectId: string,
  data: { key: string; value: string; repositoryId?: string | null },
): Promise<void> {
  const res = await fetch(`/api/projects/${projectId}/env-vars`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  if (!res.ok) return parseError(res, "Failed to add env var");
}

/**
 * Rename an env var, change its value, or both. Omitting `value` keeps the
 * stored secret — a rename does not require reading it back.
 */
export async function updateEnvVar(
  projectId: string,
  envVarId: string,
  data: { key?: string; value?: string },
): Promise<void> {
  const res = await fetch(`/api/projects/${projectId}/env-vars/${envVarId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  if (!res.ok) return parseError(res, "Failed to update env var");
}

/** Plaintext value for one env var — fetched only on reveal/copy. */
export async function revealEnvVar(
  projectId: string,
  envVarId: string,
): Promise<string> {
  const res = await fetch(
    `/api/projects/${projectId}/env-vars/${envVarId}/reveal`,
  );
  if (!res.ok) return parseError(res, "Failed to reveal env var");
  const data = (await res.json()) as { value: string };
  return data.value;
}

/** Import a pasted `.env` block. The server re-parses the raw text. */
export async function importEnvVars(
  projectId: string,
  data: {
    content: string;
    repositoryId?: string | null;
    overwrite?: boolean;
  },
): Promise<EnvImportResult> {
  const res = await fetch(`/api/projects/${projectId}/env-vars/bulk`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  if (!res.ok) return parseError(res, "Failed to import env vars");
  return res.json();
}

/** Copy env vars off a Stack canvas node into the project's env vars. */
export async function importEnvVarsFromStack(
  projectId: string,
  data: {
    nodeId: string;
    keys?: string[];
    repositoryId?: string | null;
    overwrite?: boolean;
  },
): Promise<EnvImportResult> {
  const res = await fetch(`/api/projects/${projectId}/env-vars/from-stack`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  if (!res.ok) return parseError(res, "Failed to import from stack");
  return res.json();
}

/** Saved credentials / global Settings that can seed this project's env vars. */
export async function fetchEnvPresets(
  projectId: string,
): Promise<EnvPreset[]> {
  const res = await fetch(`/api/projects/${projectId}/env-vars/from-config`);
  if (!res.ok) return parseError(res, "Failed to load config presets");
  const data = (await res.json()) as { presets: EnvPreset[] };
  return data.presets;
}

/**
 * Copy secrets from saved configs into the project's env vars. A copy, not a
 * live reference: rotating the credential later won't update the project.
 */
export async function importEnvVarsFromConfig(
  projectId: string,
  data: {
    presetIds: string[];
    repositoryId?: string | null;
    overwrite?: boolean;
  },
): Promise<EnvImportResult> {
  const res = await fetch(`/api/projects/${projectId}/env-vars/from-config`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  if (!res.ok) return parseError(res, "Failed to import from configs");
  return res.json();
}

export async function deleteEnvVar(
  projectId: string,
  envVarId: string,
): Promise<void> {
  const res = await fetch(`/api/projects/${projectId}/env-vars/${envVarId}`, {
    method: "DELETE",
  });
  if (!res.ok) return parseError(res, "Failed to delete env var");
}

export async function getSandboxes(
  projectId: string,
): Promise<SandboxSummary[]> {
  const res = await fetch(`/api/projects/${projectId}/sandboxes`);
  if (!res.ok) return parseError(res, "Failed to load sandboxes");
  return res.json();
}

export async function launchSandbox(
  projectId: string,
  provider: LaunchTarget = "civo",
  /** Blank or omitted lets the server generate `nexux-<project>-<id>`. */
  name?: string,
): Promise<SandboxSummary> {
  const res = await fetch(`/api/projects/${projectId}/sandboxes`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ provider, name }),
  });
  if (!res.ok) return parseError(res, "Failed to launch sandbox");
  return res.json();
}

export async function getSandbox(
  projectId: string,
  sandboxId: string,
): Promise<Sandbox> {
  const res = await fetch(`/api/projects/${projectId}/sandboxes/${sandboxId}`);
  if (!res.ok) return parseError(res, "Failed to load sandbox");
  return res.json();
}

export async function destroySandbox(
  projectId: string,
  sandboxId: string,
): Promise<void> {
  const res = await fetch(`/api/projects/${projectId}/sandboxes/${sandboxId}`, {
    method: "DELETE",
  });
  if (!res.ok) return parseError(res, "Failed to destroy sandbox");
}

/** Docker-only: stop/start the sandbox container. */
export async function powerSandbox(
  projectId: string,
  sandboxId: string,
  action: "pause" | "resume",
): Promise<SandboxSummary> {
  const res = await fetch(
    `/api/projects/${projectId}/sandboxes/${sandboxId}/power`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action }),
    },
  );
  if (!res.ok) return parseError(res, "Power action failed");
  return res.json();
}

export async function updateSandbox(
  projectId: string,
  sandboxId: string,
  data: { dedicated?: boolean; muteTelegram?: boolean; muteSlack?: boolean },
): Promise<SandboxSummary> {
  const res = await fetch(`/api/projects/${projectId}/sandboxes/${sandboxId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  if (!res.ok) return parseError(res, "Failed to update sandbox");
  return res.json();
}

// ---------------------------------------------------------------------------
// Dev console (dedicated sandboxes)
// ---------------------------------------------------------------------------

export type DevTaskAttachment = {
  name: string;
  mime: string;
  size: number;
};

export type DevTask = {
  id: string;
  prompt: string;
  status: string; // queued | running | completed | error | canceled
  phase: string | null; // needs_input when Claude asked for direction
  result: string | null;
  error: string | null;
  /** PR/MR the agent opened during this prompt, mined from its reply. */
  prUrl: string | null;
  costUsd: number | null;
  durationMs: number | null;
  createdAt: string;
  finishedAt: string | null;
  /** Files the user sent with this prompt (name/mime/size only). */
  attachments?: DevTaskAttachment[];
  /** Last log lines — only while the prompt is running. */
  logTail: string | null;
};

export type DevFeed = {
  tasks: DevTask[];
  muteTelegram: boolean;
  muteSlack: boolean;
  hasSession: boolean;
};

export async function getDevFeed(
  projectId: string,
  sandboxId: string,
): Promise<DevFeed> {
  const res = await fetch(
    `/api/projects/${projectId}/sandboxes/${sandboxId}/dev`,
  );
  if (!res.ok) return parseError(res, "Failed to load dev console");
  return res.json();
}

export async function sendDevPrompt(
  projectId: string,
  sandboxId: string,
  prompt: string,
  files: File[] = [],
): Promise<DevTask> {
  // Plain prompts stay JSON; attachments switch to multipart.
  let init: RequestInit;
  if (files.length > 0) {
    const form = new FormData();
    form.set("prompt", prompt);
    for (const f of files) form.append("files", f, f.name);
    init = { method: "POST", body: form };
  } else {
    init = {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt }),
    };
  }
  const res = await fetch(
    `/api/projects/${projectId}/sandboxes/${sandboxId}/dev`,
    init,
  );
  if (!res.ok) return parseError(res, "Failed to send prompt");
  return res.json();
}

export async function cancelDevPrompt(
  projectId: string,
  sandboxId: string,
  taskId: string,
): Promise<void> {
  const res = await fetch(
    `/api/projects/${projectId}/sandboxes/${sandboxId}/dev/${taskId}`,
    { method: "DELETE" },
  );
  if (!res.ok) return parseError(res, "Failed to cancel prompt");
}

/**
 * Reveal a LOCAL sandbox's mounted repo folders in the OS file manager.
 * Resolves with the opened paths; throws with the server's reason when
 * there is nothing on the host to open (cloned-inside-container repos).
 */
export async function revealSandboxFiles(
  projectId: string,
  sandboxId: string,
): Promise<string[]> {
  const res = await fetch(
    `/api/projects/${projectId}/sandboxes/${sandboxId}/reveal`,
    { method: "POST" },
  );
  const body = (await res.json().catch(() => null)) as {
    opened?: string[];
    error?: string;
  } | null;
  if (!res.ok) throw new Error(body?.error ?? "Could not open the files");
  return body?.opened ?? [];
}

export type SlackChannelOption = {
  id: string;
  name: string;
  isMember: boolean;
};

/** Channels the Slack bot can see — pickers show names, never raw IDs. */
export async function getSlackChannels(): Promise<SlackChannelOption[]> {
  const res = await fetch(`/api/slack/channels`);
  if (!res.ok) return [];
  const body = (await res.json()) as { channels: SlackChannelOption[] };
  return body.channels;
}

/** Create a public Slack channel; returns it so the picker can select it. */
export async function createSlackChannelOption(
  name: string,
): Promise<SlackChannelOption> {
  const res = await fetch(`/api/slack/channels`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as {
      error?: string;
    } | null;
    throw new Error(body?.error ?? "Could not create the channel");
  }
  const body = (await res.json()) as { channel: SlackChannelOption };
  return body.channel;
}

export type SlackStatus = {
  configured: boolean;
  team: string | null;
  botUser: string | null;
  /** App token present — thread replies (Socket Mode) can run. */
  socket: boolean;
};

/** Slack connection identity — backs the settings card's header line. */
export async function getSlackStatus(): Promise<SlackStatus> {
  const res = await fetch(`/api/slack/status`);
  if (!res.ok) {
    return { configured: false, team: null, botUser: null, socket: false };
  }
  return res.json();
}

/** Telegram bot identity — backs the "create/link group" deep link. */
export async function getTelegramBot(): Promise<{
  configured: boolean;
  username: string | null;
}> {
  const res = await fetch(`/api/telegram/bot`);
  if (!res.ok) return { configured: false, username: null };
  return res.json();
}

export async function resetDevSession(
  projectId: string,
  sandboxId: string,
): Promise<void> {
  const res = await fetch(
    `/api/projects/${projectId}/sandboxes/${sandboxId}/dev/session`,
    { method: "DELETE" },
  );
  if (!res.ok) return parseError(res, "Failed to reset session");
}

export async function startPreview(
  projectId: string,
  sandboxId: string,
): Promise<{ previewUrl: string }> {
  const res = await fetch(
    `/api/projects/${projectId}/sandboxes/${sandboxId}/preview`,
    { method: "POST" },
  );
  if (!res.ok) return parseError(res, "Could not start the preview");
  return res.json();
}

export async function stopPreview(
  projectId: string,
  sandboxId: string,
): Promise<void> {
  const res = await fetch(
    `/api/projects/${projectId}/sandboxes/${sandboxId}/preview`,
    { method: "DELETE" },
  );
  if (!res.ok) return parseError(res, "Could not stop the preview");
}

/** One startable long-running command on a sandbox — see sandbox-processes.ts. */
export type SandboxProcessView = {
  key: string;
  label: string;
  repositoryId: string | null;
  command: string;
  cwd: string;
  port: number | null;
  /**
   * Every port liveness may probe. A launcher's `port` is null by design (its
   * shell exits once the containers are detached), so these are the only ports
   * it ever reports — which makes them the honest set to offer as shortcuts.
   */
  checkPorts: number[];
  role: "run" | "services";
  source: "stack" | "repo-setup";
  id: string | null;
  status: string;
  pid: number | null;
  previewUrl: string | null;
  error: string | null;
  startedAt: string | null;
  stale: boolean;
};

export async function listSandboxProcesses(
  projectId: string,
  sandboxId: string,
): Promise<SandboxProcessView[]> {
  const res = await fetch(
    `/api/projects/${projectId}/sandboxes/${sandboxId}/processes`,
  );
  if (!res.ok) return parseError(res, "Could not load the processes");
  const body = (await res.json()) as { processes: SandboxProcessView[] };
  return body.processes;
}

export async function startSandboxProcess(
  projectId: string,
  sandboxId: string,
  key: string,
): Promise<{ process: SandboxProcessView; log: string }> {
  const res = await fetch(
    `/api/projects/${projectId}/sandboxes/${sandboxId}/processes/${encodeURIComponent(key)}`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" },
  );
  if (!res.ok) return parseError(res, "Could not start the process");
  return res.json();
}

export async function stopSandboxProcess(
  projectId: string,
  sandboxId: string,
  key: string,
): Promise<void> {
  const res = await fetch(
    `/api/projects/${projectId}/sandboxes/${sandboxId}/processes/${encodeURIComponent(key)}`,
    { method: "DELETE" },
  );
  if (!res.ok) return parseError(res, "Could not stop the process");
}

/**
 * (Re)install the in-sandbox `nexus` CLI and refresh its manifest.
 *
 * The manifest is a snapshot taken at provision time, so a canvas edit leaves
 * `nexus start` describing commands that moved. This re-renders it from the
 * current plans — the same ones the buttons above use.
 */
export async function refreshSandboxCli(
  projectId: string,
  sandboxId: string,
): Promise<{ processes: number; repos: number }> {
  const res = await fetch(
    `/api/projects/${projectId}/sandboxes/${sandboxId}/cli`,
    { method: "POST" },
  );
  if (!res.ok) return parseError(res, "Could not refresh the sandbox CLI");
  return res.json();
}

/** The browser session on a sandbox (spec 23), as the tab renders it. */
export type BrowserSessionView = {
  id: string;
  sandboxId: string;
  status: string; // stopped | starting | running | error
  display: string;
  vncPort: number;
  wsPort: number;
  cdpPort: number;
  width: number;
  height: number;
  error: string | null;
  startedAt: string | null;
  createdAt: string;
  updatedAt: string;
  /** Loopback URL on the machine running Nexus. Null unless the session is up. */
  localUrl: string | null;
  /** VNC password — only sent while the session is actually running. */
  token: string | null;
};

export async function getBrowserSession(
  projectId: string,
  sandboxId: string,
): Promise<BrowserSessionView | null> {
  const res = await fetch(
    `/api/projects/${projectId}/sandboxes/${sandboxId}/browser`,
  );
  if (!res.ok) return parseError(res, "Could not load the browser session");
  const body = (await res.json()) as { session: BrowserSessionView | null };
  return body.session;
}

export async function startBrowserSession(
  projectId: string,
  sandboxId: string,
  opts: { width?: number; height?: number } = {},
): Promise<BrowserSessionView> {
  const res = await fetch(
    `/api/projects/${projectId}/sandboxes/${sandboxId}/browser`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(opts),
    },
  );
  if (!res.ok) return parseError(res, "Could not start the browser session");
  const body = (await res.json()) as { session: BrowserSessionView };
  return body.session;
}

export async function stopBrowserSession(
  projectId: string,
  sandboxId: string,
): Promise<void> {
  const res = await fetch(
    `/api/projects/${projectId}/sandboxes/${sandboxId}/browser`,
    { method: "DELETE" },
  );
  if (!res.ok) return parseError(res, "Could not stop the browser session");
}

export async function navigateBrowserSession(
  projectId: string,
  sandboxId: string,
  url: string,
): Promise<void> {
  const res = await fetch(
    `/api/projects/${projectId}/sandboxes/${sandboxId}/browser/navigate`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url }),
    },
  );
  if (!res.ok) return parseError(res, "Could not open that address");
}

export async function getBrowserSessionLog(
  projectId: string,
  sandboxId: string,
): Promise<string> {
  const res = await fetch(
    `/api/projects/${projectId}/sandboxes/${sandboxId}/browser/log`,
  );
  if (!res.ok) return parseError(res, "Could not read the session log");
  const body = (await res.json()) as { log: string };
  return body.log;
}

export async function getSandboxProcessLog(
  projectId: string,
  sandboxId: string,
  key: string,
): Promise<string> {
  const res = await fetch(
    `/api/projects/${projectId}/sandboxes/${sandboxId}/processes/${encodeURIComponent(key)}`,
  );
  if (!res.ok) return parseError(res, "Could not read the log");
  const body = (await res.json()) as { log: string };
  return body.log;
}

export async function getVsCodeLink(
  projectId: string,
  sandboxId: string,
  path?: string,
): Promise<{ uri: string; host: string; launched: boolean }> {
  const res = await fetch(
    `/api/projects/${projectId}/sandboxes/${sandboxId}/vscode`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(path ? { path } : {}),
    },
  );
  if (!res.ok) return parseError(res, "Could not prepare the VS Code link");
  return res.json();
}

export async function getSandboxPassword(
  projectId: string,
  sandboxId: string,
): Promise<string> {
  const res = await fetch(
    `/api/projects/${projectId}/sandboxes/${sandboxId}/password`,
  );
  if (!res.ok) return parseError(res, "Failed to fetch sandbox password");
  const body = (await res.json()) as { password: string };
  return body.password;
}

export async function getCredentials(): Promise<CloudCredentialSummary[]> {
  const res = await fetch("/api/credentials");
  if (!res.ok) return parseError(res, "Failed to load credentials");
  return res.json();
}

export async function createCredential(
  input: NewCredentialInput,
): Promise<CloudCredentialSummary> {
  const res = await fetch("/api/credentials", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) return parseError(res, "Failed to save credential");
  return res.json();
}

export async function deleteCredential(credentialId: string): Promise<void> {
  const res = await fetch(`/api/credentials/${credentialId}`, {
    method: "DELETE",
  });
  if (!res.ok) return parseError(res, "Failed to delete credential");
}
