# Spec 13 — Agentic Harness (`@nexux/harness`)

## Why

Agentic brains (Claude, Codex, Ollama) only stop hallucinating when they have a
**closed feedback loop**: write code → run it → read structured result → fix.
Today Nexux exposes an *interactive* PTY (`@nexux/terminal`) meant for a human at
a keyboard. A brain needs the opposite: **non-interactive, isolated, structured
execution it drives programmatically.** That harness is the differential.

This spec defines a brain-agnostic harness primitive. Any brain calls the same
surface; isolation is real (Docker container); state is resettable.

## Non-goals

- Not a replacement for `@nexux/terminal` (interactive human PTY stays).
- Not remote/cloud execution. Local-first only.
- Not a general orchestration layer. Just: sandbox + exec + observe.

## Surface

New package `packages/harness` → `@nexux/harness`.

```ts
interface Sandbox {
  id: string;
  workdir: string;              // path inside container, e.g. /work
  exec(cmd: string, opts?: ExecOpts): Promise<ExecResult>;
  writeFile(path: string, content: string): Promise<void>;
  readFile(path: string): Promise<string>;
  destroy(): Promise<void>;
}

interface ExecOpts {
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;           // default 120_000, hard-kill on exceed
  stdin?: string;
}

interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;             // 124 = timeout (matches GNU timeout)
  durationMs: number;
  timedOut: boolean;
}

interface HarnessConfig {
  image: string;                // base image, e.g. "node:20-bookworm"
  lifecycle: "ephemeral" | "warm";
  mounts?: { host: string; container: string; ro?: boolean }[];
  network: "none" | "bridge";   // default "none" — no net unless asked
  memoryMb?: number;            // default 2048
  cpus?: number;                // default 2
}

// factory
function createHarness(cfg?: Partial<HarnessConfig>): Harness;
interface Harness {
  sandbox(): Promise<Sandbox>;  // ephemeral: fresh; warm: leased+reset
  shutdown(): Promise<void>;    // tear down warm pool
}
```

## Isolation — Docker

- Each sandbox = one `docker run` (detached, `--rm` for ephemeral).
- Defaults locked down: `--network none`, `--memory`, `--cpus`,
  `--read-only` root + writable `/work` tmpfs, drop caps, `--pids-limit`.
- `exec` = `docker exec` into the running container with the cmd; capture
  stdout/stderr separately, wrap in `timeout` for the hard kill.
- File IO via `docker cp` or exec+heredoc (start with `docker cp`, simplest).
- Brain never gets a raw shell into host. Host shell stays in `@nexux/terminal`.

### Lifecycle (configurable, default ephemeral)

- **ephemeral**: `sandbox()` → fresh container, `destroy()` → `docker rm -f`.
  Clean state guaranteed. ~300–800ms start cost.
- **warm**: pool of N pre-started containers. `sandbox()` leases one;
  `destroy()` resets `/work` (wipe tmpfs, `git clean` if repo) and returns to
  pool. Faster for tight edit→test loops. Pool size from config.

Default ephemeral. Warm is opt-in per `HarnessConfig.lifecycle`.

## Config wiring

Extend `NexuxConfig` (`packages/config/src/env.ts`) with a `harness` slice,
same lazy-getter pattern:

```ts
get harness(): HarnessConfig {
  return {
    image: optional("NEXUX_HARNESS_IMAGE", "node:20-bookworm")!,
    lifecycle: (optional("NEXUX_HARNESS_LIFECYCLE", "ephemeral") as any),
    network: (optional("NEXUX_HARNESS_NETWORK", "none") as any),
    memoryMb: Number(optional("NEXUX_HARNESS_MEM_MB", "2048")),
    cpus: Number(optional("NEXUX_HARNESS_CPUS", "2")),
  };
}
```

## Brain-facing tool

Expose harness as a tool the brain can call (Claude tool / MCP / Codex fn),
so the surface is identical regardless of brain:

- `harness_exec({ cmd, cwd?, timeoutMs? }) -> ExecResult`
- `harness_write({ path, content }) -> ok`
- `harness_read({ path }) -> content`
- `harness_reset() -> ok`

Tool layer holds one sandbox per agent session; brain just sends commands.
Structured JSON result back = the feedback loop.

## Verify loop (the point)

Canonical sequence a brain runs unattended:

1. `harness_write` generated file(s) into `/work`.
2. `harness_exec("npm test -- --reporter=json")`.
3. Branch on `exitCode` / parse JSON stdout.
4. On fail: feed `stderr` + failing cases back, regenerate, goto 1.
5. On pass: return diff to user.

Machine-readable test output (JSON reporter, exit codes) is required for the
branch in step 3 — document per-runner reporters in the package README.

## Phases

- **P0** — Docker driver, ephemeral only, `exec`/`writeFile`/`readFile`/
  `destroy`. `--network none` default. Unit-tested against `node:20`.
- **P1** — warm pool + reset. Config wiring. Timeout/limits hardening.
- **P2** — brain tool adapters (Claude tool schema + MCP server) so any brain
  calls the same surface.
- **P3** — observation extras: capture artifacts (coverage, build output),
  optional app-run + port-forward for browser/screenshot verify.

## Open questions

- Image strategy: single fat base vs per-project Dockerfile detection?
- Warm reset: tmpfs wipe enough, or snapshot/restore for speed?
- Resource accounting back to the user (cpu/mem/time per task)?
