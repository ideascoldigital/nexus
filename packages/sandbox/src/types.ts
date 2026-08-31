// Sandbox provisioning types — Terraform-managed ephemeral compute.

export type SandboxProvider = "civo" | "aws" | "local";

/** Which agent CLI runs delegated tasks inside the sandbox. */
export type SandboxBrain = "claude" | "opencode";

export type SandboxRepoSpec = {
  /** Display name; also used as the checkout directory under /opt/nexus. */
  name: string;
  /** Clone URL. Repos without a URL and without a mountPath are skipped. */
  repoUrl: string | null;
  /**
   * Host folder bind-mounted into the container at the repo's /opt/nexus
   * dir (local provider only). Set when the repo has no clone URL — the
   * sandbox works directly on the local folder, devcontainer-style.
   */
  mountPath?: string | null;
  /** Branch to clone; falls back to the repo's default branch if missing. */
  branch?: string | null;
  /**
   * The checkout every agent task cds into. Its clone failing aborts the
   * bootstrap rather than warning: a sandbox without it provisions fine and
   * then fails every task with a bare `cd: No such file or directory`.
   */
  isMain?: boolean;
  installCommand?: string | null;
  buildCommand?: string | null;
  runCommand?: string | null;
  /** Written to <repo>/.env after clone. */
  envVars?: Record<string, string>;
};

export type SandboxSpec = {
  /** Cloud provider the instance is created on. */
  provider: SandboxProvider;
  /** Instance hostname (DNS-safe). */
  name: string;
  region: string;
  size: string;
  diskImage: string;
  /** Registered with the provider via terraform (Nexus's auto-generated key). */
  sshPublicKey?: string | null;
  /** Extra public keys appended to /root/.ssh/authorized_keys (e.g. the user's own). */
  authorizedKeys?: string[];
  installDocker: boolean;
  installNode: boolean;
  installClaudeCode: boolean;
  installOpenCode?: boolean;
  installAgentBrowser: boolean;
  installCloudflared: boolean;
  /** Install tailscale and (with an auth key) join the tailnet at bootstrap. */
  installTailscale?: boolean;
  /**
   * Tailscale auth key used by `tailscale up` — ephemeral + pre-authorized
   * recommended. Null/absent with a `tailscaleLoginServer` set = interactive
   * registration (the bootstrap prints the URL to approve); null/absent with no
   * login server = install only, joining is left to the user.
   */
  tailscaleAuthKey?: string | null;
  /**
   * Coordination server to join, for a self-hosted control plane (Headscale) —
   * `--login-server`. Absent means Tailscale's own (login.tailscale.com).
   * A self-hosted server has no admin console to mint keys from, so this is
   * also what makes the keyless interactive join meaningful.
   */
  tailscaleLoginServer?: string | null;
  /** opencode -m "provider/model" written into the injected OpenCode config. */
  openCodeModel?: string | null;
  /**
   * Claude Code's `model` — written into the sandbox's own settings.json.
   *
   * Delegated tasks and the dev console pass it per invocation, so they were
   * always right; an interactive `claude` in the in-app terminal read the
   * settings file instead and got the default. The setting lives under
   * "Sandbox settings", so it has to hold inside the sandbox too.
   */
  claudeModel?: string | null;
  /** Extra bash appended at the end of the bootstrap script. */
  setupScript?: string | null;
  /**
   * Claude Code MCP servers (native `mcpServers` shape) — merged into
   * ~/.claude.json for the agent user and root at bootstrap, so headless
   * runs, the dev console and the in-app terminal all load them.
   */
  mcpServers?: Record<string, unknown> | null;
  /** docker-compose YAML for stack services; started before repos are cloned. */
  stackComposeYaml?: string | null;
  /** Compose service names, for log lines only. */
  stackServiceNames?: string[];
  /**
   * Local stack nodes whose command launches their own containers
   * (`make docker-up`). Unlike stackComposeYaml these are the repo's own
   * scripts, so they run after the checkouts exist.
   */
  stackLaunchers?: Array<{
    /** Node name, for log lines. */
    name: string;
    /** Repo directory name under /opt/nexus (safeSlug of the repo name). */
    repoDir: string;
    /** Sub-directory inside the repo, "" for its root. */
    workdir: string;
    startCommand: string;
  }>;
  /** Project-wide vars, exported for every login shell on the instance. */
  envVars: Record<string, string>;
  repos: SandboxRepoSpec[];
};

export type ProvisionOutputs = {
  instanceId?: string;
  publicIp?: string;
};

export type LogSink = (chunk: string) => void;

export type TerraformResult = {
  code: number;
  stdout: string;
  stderr: string;
};
