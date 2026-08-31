// Shared types for the project Stack feature (canvas + compose + runner).
// Client-safe: no server imports.

export type StackNodeKind = "repo" | "service";
export type StackRunMode = "docker" | "local";

// --- Phases (spec 17) ---
//
// A node's commands, each declaring what it does and what executes it. Derived
// from the legacy columns today (see phases.ts); persisted later. `runMode` +
// `managesServices` cannot express a repo that installs on the host, brings
// infra up in Docker and then runs the app — phases can.

/** How a phase's command executes — what owns the process. */
export type ExecKind =
  /** A process on the host / sandbox instance. */
  | "host"
  /** A service in the compose file Nexus generates. */
  | "compose"
  /** Delegated to a compose file the repo owns (`make docker-up`). */
  | "compose-extern"
  /** A single image, no compose. */
  | "container";

/** What a phase is for. Order within a node is the order they run. */
export type PhaseRole = "install" | "build" | "services" | "run" | "stop";

export type StackPhase = {
  role: PhaseRole;
  exec: ExecKind;
  command: string | null;
  /** Image, when exec is "container" or "compose". */
  image?: string | null;
  /** Compose file the command drives, when exec is "compose-extern". */
  composePath?: string | null;
  /** Container/service names this phase brings up, when known. */
  provides?: string[];
  /** The command exits once its background work is launched. */
  detached?: boolean;
  /** Where the command runs, relative to the repo root. */
  workdir?: string | null;
};

export type PortMapping = { host: number; container: number };
export type EnvVar = { key: string; value: string };
export type VolumeMapping = { host: string; container: string };

/**
 * What a `make` target hides. A target name says nothing about its recipe:
 * `make dev` may be a bare `next dev` or a `docker compose up`. Reading the
 * recipe is what lets the stack tell whether a node needs Docker at all.
 */
export type MakeTarget = {
  name: string;
  /** Prerequisites, so `dev: up` can inherit what `up` does. */
  prerequisites: string[];
  /** The recipe drives docker (compose, `docker run`, `docker build`). */
  usesDocker: boolean;
  /** Compose files the recipe passes with `-f`, relative to the Makefile. */
  composeFiles: string[];
  /** Compose services the recipe names explicitly, e.g. `up -d postgres`. */
  composeServices: string[];
  /** The recipe brings containers/processes up and returns (`up -d`). */
  detached: boolean;
  /** The recipe reads like teardown (`down`, `stop`, `rm`, `kill`). */
  teardown: boolean;
};

export type DetectionResult = {
  scannedAt: string;
  hasDockerfile: boolean;
  dockerfilePath?: string;
  hasCompose: boolean;
  composePath?: string;
  hasMakefile?: boolean;
  makefilePath?: string;
  makeTargets?: string[];
  /** Per-target analysis of what the recipe actually does — see MakeTarget. */
  makeTargetDetails?: MakeTarget[];
  packageManager: "pnpm" | "npm" | "yarn" | null;
  scripts: Record<string, string>;
  /** Things worth telling the user about the scan, e.g. an ignored lockfile. */
  notes?: string[];
  suggestedCommands: {
    install?: string;
    dev?: string;
    build?: string;
    start?: string;
  };
  envExampleKeys: string[];
  suggestedPorts: number[];
};

export type StackNodeDTO = {
  id: string;
  projectId: string;
  kind: StackNodeKind;
  repositoryId: string | null;
  name: string;
  runMode: StackRunMode;
  image: string | null;
  dockerfile: string | null;
  buildContext: string | null;
  command: string | null;
  /** How this repo installs deps, e.g. "pnpm install". */
  installCommand: string | null;
  /** How this repo builds, e.g. "pnpm build". */
  buildCommand: string | null;
  localCommand: string | null;
  /** Optional teardown run on Down, e.g. "make docker-down". */
  stopCommand: string | null;
  /** Command only launches background work (containers, a daemon) and exits. */
  managesServices: boolean;
  workdir: string | null;
  ports: PortMapping[] | null;
  env: EnvVar[] | null;
  volumes: VolumeMapping[] | null;
  detection: DetectionResult | null;
  /**
   * The node's steps, in order — the source of truth for what it runs. Null on
   * rows written before spec 17 step 2; read with `nodePhases`, which derives
   * from the command columns above in that case.
   */
  phases: StackPhase[] | null;
  posX: number;
  posY: number;
};

export type StackEdgeDTO = {
  id: string;
  sourceId: string;
  targetId: string;
};

export type StackGraph = {
  nodes: StackNodeDTO[];
  edges: StackEdgeDTO[];
};

// Input for PUT /stack — client-side ids may be temporary ("tmp-...")
export type StackNodeInput = Omit<StackNodeDTO, "projectId" | "detection"> & {
  detection?: DetectionResult | null;
};

export type StackSaveInput = {
  nodes: StackNodeInput[];
  edges: { sourceId: string; targetId: string }[];
};

export type StackStatus = {
  running: boolean;
  compose: Array<{ service: string; state: string }>;
  local: Array<{
    nodeId: string;
    name: string;
    pid: number | null;
    running: boolean;
    /** Something outside Nexus holds the node's port (a manual `pnpm dev`). */
    external?: boolean;
    /** Port that proved it is up, when detection came from a port probe. */
    port?: number;
  }>;
};

export type StackLogLine = {
  seq: number;
  ts: number;
  source: string; // "compose" | "runner" | node name
  line: string;
};

export type ComposeResult = {
  path: string | null;
  yaml: string;
  warnings: string[];
};

// --- Stack assistant (AI chat panel) ---

// A structured, user-applicable suggestion emitted by the assistant as a
// trailing ```json block: { "suggestions": [...] }.
export type StackSuggestionPatch = Partial<
  Pick<
    StackNodeDTO,
    | "runMode"
    | "image"
    | "dockerfile"
    | "buildContext"
    | "command"
    | "installCommand"
    | "buildCommand"
    | "localCommand"
    | "stopCommand"
    | "managesServices"
    | "workdir"
    | "ports"
    | "env"
    | "volumes"
  >
>;

export type StackSuggestion = {
  /** Target an existing canvas node... */
  nodeId?: string;
  /** ...or a project repository (node created if not on canvas). */
  repositoryId?: string;
  /** Create a new infra service node (catalog key or raw image). */
  createService?: { catalogKey?: string; image?: string; name?: string };
  patch?: StackSuggestionPatch;
  reason: string;
};

export type StackAssistantMessage = {
  id: string;
  role: string;
  agentRole: string | null;
  content: string;
  createdAt: string;
};

export type StackAssistantState = {
  conversationId: string;
  messages: StackAssistantMessage[];
  indexStatus: { indexed: boolean; count: number };
};

export type StackAssistantReply = {
  message: string;
  suggestions: StackSuggestion[];
  toolCalls: string[];
  conversationId: string;
};

/** What a sandbox inherits from the Stack canvas — see sandbox-inheritance.ts. */
export type StackInheritance = {
  /** Node the app facts came from, for UI attribution. */
  appName: string | null;
  /** Command that boots the app, from the main repo's local node. */
  runCommand: string | null;
  /** Port that command serves on, declared or inferred from the script. */
  previewPort: number | null;
  /** Any docker node, or a local node that drives containers. */
  needsDocker: boolean;
  /** Local nodes whose command launches containers (`make docker-up`). */
  serviceLaunchers: Array<{
    name: string;
    repoName: string | null;
    workdir: string;
    startCommand: string;
    stopCommand: string | null;
  }>;
  /**
   * Per-repository run command taken from its stack node — what the canvas
   * says actually boots that repo, beating any generic detection guess.
   */
  repoCommands: Array<{
    repositoryId: string;
    /** Stack node name, for UI attribution. */
    nodeName: string;
    installCommand: string | null;
    buildCommand: string | null;
    runCommand: string | null;
    /** True when the command launches containers rather than the app. */
    managesServices: boolean;
  }>;
  /** Human-readable notes for the sandbox UI. */
  notes: string[];
};
