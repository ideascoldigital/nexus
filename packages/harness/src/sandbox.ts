// DockerSandbox — one running container the brain drives via exec/file IO.

import { docker } from "./docker";
import type { ExecOpts, ExecResult, HarnessConfig, Sandbox } from "./types";

const DEFAULT_TIMEOUT_MS = 120_000;

export class DockerSandbox implements Sandbox {
  readonly id: string;
  readonly workdir: string;
  private cfg: HarnessConfig;
  private started = false;

  constructor(id: string, cfg: HarnessConfig) {
    this.id = id;
    this.cfg = cfg;
    this.workdir = cfg.workdir ?? "/work";
  }

  /** docker run -d the container, locked down per config. */
  async start(): Promise<void> {
    if (this.started) return;
    const args = [
      "run",
      "-d",
      "--name",
      this.id,
      "--network",
      this.cfg.network,
      "--memory",
      `${this.cfg.memoryMb ?? 2048}m`,
      "--cpus",
      String(this.cfg.cpus ?? 2),
      "--pids-limit",
      "512",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "-w",
      this.workdir,
    ];

    // Writable tmpfs workdir; root stays read-only for safety.
    args.push("--read-only");
    args.push("--tmpfs", `${this.workdir}:exec,size=512m`);

    for (const m of this.cfg.mounts ?? []) {
      args.push("-v", `${m.host}:${m.container}${m.ro ? ":ro" : ""}`);
    }

    // Keep container alive; we drive it with `docker exec`.
    args.push(this.cfg.image, "sleep", "infinity");

    const r = await docker(args, { timeoutMs: 60_000 });
    if (r.exitCode !== 0) {
      throw new Error(`harness: failed to start container: ${r.stderr.trim()}`);
    }
    this.started = true;
  }

  async exec(cmd: string, opts: ExecOpts = {}): Promise<ExecResult> {
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const args = ["exec"];

    if (opts.stdin !== undefined) args.push("-i");
    if (opts.cwd) args.push("-w", opts.cwd);
    for (const [k, v] of Object.entries(opts.env ?? {})) {
      args.push("-e", `${k}=${v}`);
    }
    // Run under sh -c so the brain can use a normal shell command string.
    args.push(this.id, "sh", "-c", cmd);

    const startedAt = nowMs();
    const r = await docker(args, { timeoutMs, stdin: opts.stdin });
    const durationMs = nowMs() - startedAt;
    const timedOut = r.exitCode === 124;

    return {
      stdout: r.stdout,
      stderr: r.stderr,
      exitCode: r.exitCode,
      durationMs,
      timedOut,
    };
  }

  async writeFile(filePath: string, content: string): Promise<void> {
    const abs = this.resolve(filePath);
    // `docker cp` targets the container rootfs, which is --read-only; it
    // ignores the tmpfs /work mount. Stream content over stdin via `exec`
    // instead — that lands in the writable tmpfs. `cat > file` keeps the
    // bytes exact (no shell interpolation of the payload).
    const dir = posixDirname(abs);
    if (dir && dir !== "/") {
      const mk = await this.exec(`mkdir -p ${shellQuote(dir)}`);
      if (mk.exitCode !== 0) {
        throw new Error(`harness: writeFile mkdir failed: ${mk.stderr.trim()}`);
      }
    }
    const r = await this.exec(`cat > ${shellQuote(abs)}`, { stdin: content });
    if (r.exitCode !== 0) {
      throw new Error(`harness: writeFile failed: ${r.stderr.trim()}`);
    }
  }

  async readFile(filePath: string): Promise<string> {
    const abs = this.resolve(filePath);
    const r = await this.exec(`cat ${shellQuote(abs)}`);
    if (r.exitCode !== 0) {
      throw new Error(`harness: readFile failed: ${r.stderr.trim()}`);
    }
    return r.stdout;
  }

  async destroy(): Promise<void> {
    if (!this.started) return;
    await docker(["rm", "-f", this.id], { timeoutMs: 30_000 });
    this.started = false;
  }

  private resolve(p: string): string {
    return p.startsWith("/") ? p : posixJoin(this.workdir, p);
  }
}

// --- helpers (POSIX path math; container paths are always POSIX) ---

function nowMs(): number {
  return Number(process.hrtime.bigint() / 1_000_000n);
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function posixJoin(a: string, b: string): string {
  return `${a.replace(/\/$/, "")}/${b.replace(/^\//, "")}`;
}

function posixDirname(p: string): string {
  const i = p.lastIndexOf("/");
  return i <= 0 ? "/" : p.slice(0, i);
}
