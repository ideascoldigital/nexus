export * from "./types";
export {
  renderMainTf,
  renderCloudInit,
  renderTfVars,
  safeSlug,
  AGENT_USER,
  BOOTSTRAP_COMPLETE_MARKER,
  BOOTSTRAP_FAILED_MARKER,
  parseTailscaleAuthUrl,
  renderRepoSetup,
  renderTailscaleApprovalWait,
  renderTailscaleLogin,
  TS_APPROVAL_TIMEOUT_SECONDS,
  TS_UP_LOG,
} from "./template";
export {
  sandboxInstanceName,
  customSandboxName,
  normalizeSandboxPrefix,
  DEFAULT_SANDBOX_PREFIX,
  MAX_HOSTNAME_LENGTH,
  MAX_CUSTOM_NAME_LENGTH,
  MAX_SANDBOX_PREFIX_LENGTH,
  type SandboxNameError,
  type SandboxPrefixError,
} from "./slug";
export {
  buildNexusManifest,
  manifestFromSpec,
  renderNexusCliSection,
  NEXUS_CLI_PATH,
  NEXUS_MANIFEST_PATH,
  type NexusManifest,
  type NexusManifestProcess,
} from "./nexus-cli";
// Nexus host (spec 19): the 24/7 VM that runs Nexus itself. Shares the
// Terraform module above; only the bootstrap differs.
export {
  renderHostCloudInit,
  renderHostCompose,
  parseHostMarker,
  safeHostName,
  isValidImageRef,
  initialSshUser,
  registryHost,
  HOST_DIR,
  HOST_BOOTSTRAP_LOG,
  HOST_CONTROL_DIR,
  HOST_MARKER,
  HOST_UPDATE_LOG,
  HOST_UPDATE_REQUEST,
  type NexusHostSpec,
} from "./template-host";
// Spec 23 — the interactive browser session on a sandbox.
export {
  renderBrowserInstallSection,
  renderBrowserStartScript,
  renderBrowserStopScript,
  parseBrowserStart,
  isValidDisplay,
  isValidPort,
  isValidDimension,
  BROWSER_DIR,
  BROWSER_LOG,
  BROWSER_READY_MARKER,
  DEFAULT_DISPLAY,
  DEFAULT_VNC_PORT,
  DEFAULT_WS_PORT,
  DEFAULT_CDP_PORT,
  DEFAULT_WIDTH,
  DEFAULT_HEIGHT,
  VNC_TOKEN_LENGTH,
  type BrowserSessionSpec,
} from "./template-browser";
export { runTerraform, terraformAvailable } from "./terraform";
export {
  ensureSandboxKeypair,
  sandboxKeyDir,
  sandboxPrivateKeyPath,
} from "./keys";
export {
  ensureUserSshInclude,
  removeSandboxSshHost,
  sandboxSshConfigPath,
  sandboxSshHostAlias,
  upsertSandboxSshHost,
  vsCodeRemoteUri,
  type SandboxSshHostOpts,
} from "./ssh-config";
export {
  buildClaudeCommand,
  createStreamParser,
  describeEvent,
  execRemote,
  fetchRemoteDir,
  pushLocalDir,
  finalizeClaudeRun,
  runClaudeTask,
  sandboxShellCommand,
  type ClaudeRunResult,
  type RemoteExecOpts,
  type RemoteResult,
  type SandboxAddress,
  type StreamEvent,
} from "./remote";
export {
  applyGlobalSecrets,
  applyLlmCredentials,
  GLOBAL_ENV_SETTINGS,
  LLM_CREDENTIAL_ENV,
  LLM_CREDENTIAL_PROVIDERS,
  type GlobalSecretRow,
} from "./env";
export {
  buildOpenCodeCommand,
  createOpenCodeStreamParser,
  describeOpenCodeEvent,
  finalizeOpenCodeRun,
  runAgentTask,
  runOpenCodeTask,
  type AgentRunOpts,
  type AgentRunResult,
} from "./runner";
export {
  applySandbox,
  destroySandbox,
  prepareWorkDir,
  readInitialPassword,
  readOutputs,
  type ProviderCredentials,
} from "./provisioner";
export {
  pickMainRepo,
  renderCodeWorkspace,
  repoDir,
  resolveVsCodeFolder,
  writeCodeWorkspaceCommand,
  SANDBOX_ROOT,
  SANDBOX_WORKSPACE_PATH,
  type MainRepoCandidate,
  type WorkspaceFolder,
} from "./workspace";
export {
  dockerAvailable,
  launchLocalSandbox,
  localBootstrapComplete,
  localBootstrapFailure,
  localContainerExists,
  localSandboxRunning,
  destroyLocalSandbox,
  pauseLocalSandbox,
  resumeLocalSandbox,
} from "./local";
