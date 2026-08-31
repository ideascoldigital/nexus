// @nexux/harness — public types
// Brain-agnostic sandboxed execution. See specs/13-harness.md.

export type Lifecycle = "ephemeral" | "warm";
export type NetworkMode = "none" | "bridge";

export interface ExecOpts {
  cwd?: string;
  env?: Record<string, string>;
  /** Hard-kill after this many ms. Default 120_000. exitCode becomes 124. */
  timeoutMs?: number;
  stdin?: string;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  /** 124 = timeout (matches GNU `timeout`). */
  exitCode: number;
  durationMs: number;
  timedOut: boolean;
}

export interface Mount {
  host: string;
  container: string;
  ro?: boolean;
}

export interface HarnessConfig {
  /** Base image, e.g. "node:20-bookworm". */
  image: string;
  lifecycle: Lifecycle;
  /** Default "none" — no network unless explicitly bridged. */
  network: NetworkMode;
  mounts?: Mount[];
  memoryMb?: number;
  cpus?: number;
  /** Warm pool size when lifecycle === "warm". Default 2. */
  poolSize?: number;
  /** Working dir inside container. Default "/work". */
  workdir?: string;
}

export interface Sandbox {
  readonly id: string;
  readonly workdir: string;
  exec(cmd: string, opts?: ExecOpts): Promise<ExecResult>;
  writeFile(path: string, content: string): Promise<void>;
  readFile(path: string): Promise<string>;
  /** Ephemeral: rm -f container. Warm: reset workdir, return to pool. */
  destroy(): Promise<void>;
}

export interface Harness {
  sandbox(): Promise<Sandbox>;
  /** Tear down warm pool / cleanup. */
  shutdown(): Promise<void>;
}
