// Thin wrapper over the `docker` CLI. No SDK dep — keeps install light and
// works with whatever Docker the user already runs.

import { spawn } from "child_process";

export interface RawResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface SpawnOpts {
  /** Hard-kill after this many ms. On kill, RawResult.exitCode = 124. */
  timeoutMs?: number;
  /** Written to stdin then closed. */
  stdin?: string;
}

/**
 * Run a docker subcommand. `args` are passed verbatim (no shell), so no
 * injection surface from interpolated values. The command the brain wants to
 * run inside the container is itself passed as argv (see exec()), not a shell
 * string concatenation.
 */
export function docker(args: string[], opts: SpawnOpts = {}): Promise<RawResult> {
  return run("docker", args, opts);
}

export function run(
  bin: string,
  args: string[],
  opts: SpawnOpts = {},
): Promise<RawResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["pipe", "pipe", "pipe"] });

    let stdout = "";
    let stderr = "";
    let killed = false;

    const timer = opts.timeoutMs
      ? setTimeout(() => {
          killed = true;
          child.kill("SIGKILL");
        }, opts.timeoutMs)
      : null;

    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));

    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });

    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolve({
        stdout,
        stderr,
        exitCode: killed ? 124 : (code ?? -1),
      });
    });

    if (opts.stdin !== undefined) {
      child.stdin.write(opts.stdin);
    }
    child.stdin.end();
  });
}

/** Verify docker is installed and the daemon is reachable. */
export async function dockerAvailable(): Promise<boolean> {
  try {
    const r = await docker(["info", "--format", "{{.ServerVersion}}"], {
      timeoutMs: 10_000,
    });
    return r.exitCode === 0;
  } catch {
    return false;
  }
}
