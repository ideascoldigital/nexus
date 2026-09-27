/**
 * The MCP control surface's vocabulary (spec 21).
 *
 * Nothing in this package imports Prisma, Next, or anything else from the web
 * app: a tool receives a `NexuxContext` and may only call what that interface
 * exposes. That is what lets the same tools run in-process behind
 * `/api/mcp` today and behind a published stdio binary later, and it is also
 * what makes the scope check enforceable — a tool that could reach the
 * database directly could reach every table regardless of its scopes.
 */

/** Scope names, duplicated deliberately — see `SCOPES` below. */
export const SCOPES = [
  "projects:read",
  "tasks:read",
  "tasks:write",
  "sandboxes:read",
  "sandboxes:write",
] as const;

export type Scope = (typeof SCOPES)[number];

// The web app has its own copy of this list (`lib/api-scopes.ts`) because it
// must not import a package to render a settings checkbox, and this package
// must not import the app. `scopes.test.ts` in apps/web asserts the two agree,
// so the duplication cannot drift silently.

export type ProjectSummary = {
  id: string;
  name: string;
  createdAt: string;
};

export type SandboxSummary = {
  id: string;
  projectId: string;
  name: string;
  status: string;
  provider: string;
  /**
   * Where it runs, in words: "this machine", a Docker endpoint's name (spec
   * 26), or the cloud region. A caller choosing where to send work needs to
   * tell a container on the LAN box from one on this laptop.
   */
  runsOn: string;
  /** The Docker endpoint a local sandbox runs on; null = this machine / cloud. */
  dockerEndpointId: string | null;
  previewUrl: string | null;
  createdAt: string;
};

/** Another machine's Docker that local sandboxes can run on (spec 26). */
export type DockerEndpointSummary = {
  id: string;
  name: string;
  host: string;
  arch: string | null;
  memTotalMb: number | null;
  /**
   * The last "can this host a sandbox" check (spec 28): true all green, false
   * something failed, null never checked.
   */
  sandboxReady: boolean | null;
};

export type TaskSummary = {
  id: string;
  projectId: string;
  sandboxId: string;
  featureId: string | null;
  status: string;
  /** True while the run is stopped waiting for a human answer. */
  needsInput: boolean;
  prompt: string;
  branch: string | null;
  prUrl: string | null;
  createdAt: string;
  finishedAt: string | null;
};

/** What is happening right now, the same shape the ⌘J switcher reads. */
export type ActivitySummary = {
  blocked: TaskSummary[];
  running: TaskSummary[];
  queued: TaskSummary[];
  recentlyFinished: TaskSummary[];
  idleSandboxes: SandboxSummary[];
};

export type CreateTaskInput = {
  projectId: string;
  sandboxId: string;
  prompt: string;
  featureId?: string | null;
  followUpOf?: string | null;
};

export type LaunchSandboxInput = {
  projectId: string;
  /** Omitted lets the host apply the project's configured default. */
  provider?: string;
  name?: string;
  /**
   * Local sandboxes only: a Docker endpoint's id or name, or "this-machine".
   * Omitted lets the host apply the project's saved choice.
   */
  dockerEndpoint?: string;
};

/** What a seed reset did (spec 29 phase 3). */
export type SeedResetSummary = {
  ok: boolean;
  services: Array<{ service: string; ok: boolean; message: string }>;
  setup: { ok: boolean; failed: string[] } | null;
};

export type PowerAction = "pause" | "resume";

/**
 * Everything a tool is allowed to do. The host implements this; the package
 * only calls it. Adding a capability here is a deliberate widening of what any
 * token can ever reach, which is the point of it being one small interface
 * rather than a database handle.
 */
export type NexuxContext = {
  listProjects(): Promise<ProjectSummary[]>;
  getActivity(): Promise<ActivitySummary>;
  listSandboxes(projectId: string): Promise<SandboxSummary[]>;
  listDockerEndpoints(): Promise<DockerEndpointSummary[]>;
  getTask(taskId: string): Promise<TaskSummary | null>;
  getTaskLogs(taskId: string, tailLines?: number): Promise<string | null>;
  createTask(input: CreateTaskInput): Promise<TaskSummary>;
  launchSandbox(input: LaunchSandboxInput): Promise<SandboxSummary>;
  powerSandbox(sandboxId: string, action: PowerAction): Promise<SandboxSummary>;
  /**
   * Spec 29 — empty a running sandbox's seeded databases, restore the
   * project's seeds, re-run the repos' install step. Destroys whatever the
   * sandbox wrote to those databases; hence the write scope.
   */
  resetSandboxData(sandboxId: string, service?: string): Promise<SeedResetSummary>;
  /** Spec 24 piece 4 — would this project's stack boot, and did it last time? */
  validateStack(projectId: string): Promise<StackValidationSummary>;
  /** The stack graph, for a caller deciding what to change. */
  describeStack(projectId: string): Promise<unknown>;
  /**
   * Spec 25 piece 2 — validate, patch, re-validate, up to a few rounds.
   *
   * Writes: it changes the project's stack definition and runs validations
   * that may provision a container. Hence the write scope, unlike the read
   * pair above.
   */
  repairStack(projectId: string, maxRounds?: number): Promise<unknown>;
};

/** One thing wrong with a stack definition (spec 24 piece 4). */
export type StackFinding = {
  rule: string;
  severity: "error" | "warning" | "info";
  nodeId: string | null;
  nodeName: string | null;
  message: string;
  fix?: string;
};

/** One step a real bootstrap recorded. */
export type StackStep = {
  step: string;
  exitCode: number;
  durationMs: number;
  /** Last lines of the step's own output, on a failure that carries them. */
  tail?: string;
};

export type StackValidationSummary = {
  /** The static checks passed — no errors. Says nothing about booting. */
  ok: boolean;
  findings: StackFinding[];
  /**
   * What the project's most recent sandbox actually recorded, when one is
   * reachable. `booted` is null when no app declared a port to probe, which is
   * a different answer from "the app failed to start".
   */
  observed: {
    sandboxName: string;
    provisionedAt: string;
    booted: boolean | null;
    failed: StackStep[];
    unavailable?: string;
  } | null;
};

/** JSON Schema for a tool's arguments, as MCP sends it to the client. */
export type JsonSchema = {
  type: "object";
  properties: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
};

export type ToolDefinition<Args = Record<string, unknown>> = {
  name: string;
  description: string;
  /** Every tool declares exactly one scope — see `registry.ts`. */
  scope: Scope;
  inputSchema: JsonSchema;
  /**
   * Narrows the raw JSON arguments a client sent, or throws `ToolInputError`.
   * Hand-written rather than schema-derived: the package carries no validation
   * dependency, and the checks a tool actually needs are few.
   */
  parse(raw: unknown): Args;
  run(ctx: NexuxContext, args: Args): Promise<unknown>;
};

/** Bad arguments from the client — a 400, not a crash. */
export class ToolInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolInputError";
  }
}

/** The caller lacks the scope a tool declares — a 403, and never a hint. */
export class ScopeError extends Error {
  constructor(readonly required: Scope) {
    super(`This token is missing the ${required} scope`);
    this.name = "ScopeError";
  }
}
