// Local sandboxes: the same bootstrap as a Civo instance, but inside a
// privileged Docker container on this machine (docker-in-docker so the stack
// services come up exactly like in the cloud). Exec goes through
// `docker exec` — see remote.ts's container transport.

import { spawn } from "child_process";
import type { LogSink, SandboxSpec } from "./types";
import {
  BOOTSTRAP_COMPLETE_MARKER,
  BOOTSTRAP_FAILED_MARKER,
  renderCloudInit,
  safeSlug,
} from "./template";

const BASE_IMAGE = "ubuntu:22.04";
export const LOCAL_BOOTSTRAP_LOG = "/var/log/nexus-bootstrap.log";

function run(
  bin: string,
  args: string[],
  opts: { onLog?: LogSink; timeoutMs?: number } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args);
    let stdout = "";
    let stderr = "";
    let timer: NodeJS.Timeout | undefined;
    if (opts.timeoutMs) {
      timer = setTimeout(() => child.kill("SIGKILL"), opts.timeoutMs);
    }
    child.stdout.on("data", (c: Buffer) => {
      const t = c.toString();
      stdout += t;
      opts.onLog?.(t);
    });
    child.stderr.on("data", (c: Buffer) => {
      const t = c.toString();
      stderr += t;
      opts.onLog?.(t);
    });
    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

/**
 * Memory ceiling for a sandbox container, as a fraction of what Docker itself
 * has. Unlimited is the dangerous default: a dev server that spawns a worker
 * per file (Turbopack does exactly this for PostCSS) climbs until the *engine*
 * runs out, and the kernel then kills whatever it likes — other sandboxes
 * included. Capped, the culprit dies alone and its exit code says so.
 *
 * Two-thirds leaves room for the other containers plus the engine itself. Falls
 * back to unlimited when Docker will not say how much it has, since guessing a
 * number could be smaller than the box needs.
 */
export function memoryLimitFromTotalBytes(total: number): number | null {
  if (!Number.isFinite(total) || total <= 0) return null;
  const mb = Math.floor((total / 1024 / 1024) * (2 / 3));
  // Below this a bootstrap cannot finish, so an unlimited container that might
  // survive beats a capped one that certainly will not.
  return mb >= 1024 ? mb : null;
}

export async function sandboxMemoryLimitMb(): Promise<number | null> {
  try {
    const res = await run("docker", ["info", "--format", "{{.MemTotal}}"], {
      timeoutMs: 15_000,
    });
    return memoryLimitFromTotalBytes(Number(res.stdout.trim()));
  } catch {
    return null;
  }
}

export async function dockerAvailable(): Promise<boolean> {
  try {
    const res = await run("docker", ["info"], { timeoutMs: 15_000 });
    return res.code === 0;
  } catch {
    return false;
  }
}

/**
 * Create the sandbox container and kick off the bootstrap inside it.
 * Resolves once the container exists and the bootstrap is running detached;
 * poll `localBootstrapComplete` for readiness.
 */
export async function launchLocalSandbox(opts: {
  name: string;
  spec: SandboxSpec;
  onLog?: LogSink;
}): Promise<{ containerName: string }> {
  const { name, spec, onLog } = opts;

  onLog?.(`[nexux] pulling ${BASE_IMAGE}\n`);
  await run("docker", ["pull", BASE_IMAGE], { onLog, timeoutMs: 300_000 });

  // Repos without a clone URL link the local folder straight into the
  // container (devcontainer-style): the sandbox works on the real files, no
  // git remote required.
  const mounts = spec.repos
    .filter((r) => !r.repoUrl && r.mountPath)
    .flatMap((r) => {
      const dir = `/opt/nexus/${safeSlug(r.name)}`;
      onLog?.(`[nexux] mounting ${r.mountPath} → ${dir}\n`);
      return ["-v", `${r.mountPath}:${dir}`];
    });

  const memoryMb = await sandboxMemoryLimitMb();
  if (memoryMb) {
    onLog?.(`[nexux] memory limit ${memoryMb}m\n`);
  } else {
    onLog?.(`[nexux] WARN: no memory limit — a runaway build can take the host down\n`);
  }

  onLog?.(`[nexux] creating container ${name}\n`);
  const created = await run(
    "docker",
    [
      "run",
      "-d",
      "--privileged", // docker-in-docker for the stack services
      ...(memoryMb ? ["--memory", `${memoryMb}m`] : []),
      // Inner dockerd storage must NOT sit on the container's overlayfs
      // (whiteout extraction fails on overlay-over-overlay) — give it a
      // real volume.
      "-v",
      `${name}-docker:/var/lib/docker`,
      ...mounts,
      "--name",
      name,
      "--hostname",
      name,
      "--label",
      "nexux-sandbox=1",
      BASE_IMAGE,
      "sleep",
      "infinity",
    ],
    { onLog, timeoutMs: 120_000 },
  );
  if (created.code !== 0) {
    throw new Error(
      `docker run failed: ${created.stderr.trim().slice(-300) || created.stdout.trim().slice(-300)}`,
    );
  }

  // Same script the cloud instance gets via cloud-init, in container mode.
  // Staged via printf %s with the script as a single argv element — no
  // heredoc/quoting pitfalls.
  const script = renderCloudInit(spec, { mode: "container" });
  const staged = await run(
    "docker",
    [
      "exec",
      name,
      "bash",
      "-c",
      `printf '%s' ${shellQuote(script)} > /opt/nexus-bootstrap.sh && chmod +x /opt/nexus-bootstrap.sh`,
    ],
    { timeoutMs: 30_000 },
  );
  if (staged.code !== 0) {
    throw new Error(
      `could not stage bootstrap: ${staged.stderr.trim().slice(-300)}`,
    );
  }

  onLog?.(`[nexux] bootstrap started — tail ${LOCAL_BOOTSTRAP_LOG} inside the container\n`);
  const kicked = await run(
    "docker",
    ["exec", "-d", name, "bash", "/opt/nexus-bootstrap.sh"],
    { timeoutMs: 30_000 },
  );
  if (kicked.code !== 0) {
    throw new Error(
      `could not start bootstrap: ${kicked.stderr.trim().slice(-300)}`,
    );
  }

  return { containerName: name };
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Has the bootstrap finished? (completion marker written at the end.) */
export async function localBootstrapComplete(name: string): Promise<boolean> {
  const res = await run(
    "docker",
    ["exec", name, "test", "-f", BOOTSTRAP_COMPLETE_MARKER],
    { timeoutMs: 15_000 },
  ).catch(() => ({ code: 1, stdout: "", stderr: "" }));
  return res.code === 0;
}

/**
 * Why the bootstrap gave up, or null if it has not. Read alongside the
 * completion marker so a fatal step surfaces its reason immediately instead of
 * as a twenty-minute "bootstrap did not finish" that names nothing.
 */
export async function localBootstrapFailure(
  name: string,
): Promise<string | null> {
  const res = await run("docker", ["exec", name, "cat", BOOTSTRAP_FAILED_MARKER], {
    timeoutMs: 15_000,
  }).catch(() => ({ code: 1, stdout: "", stderr: "" }));
  if (res.code !== 0) return null;
  const reason = res.stdout.trim();
  return reason || "bootstrap reported a fatal step without a reason";
}

/**
 * Does a container by this name exist on the host — running, stopped or dead?
 *
 * Docker names are unique across all states, so a stopped container still owns
 * its name and `docker run` fails with a conflict. Checking only our own
 * database would miss it: a container can outlive the row that created it (a
 * destroy that half-failed), and the host is shared with whatever else the
 * user runs.
 */
export async function localContainerExists(name: string): Promise<boolean> {
  const res = await run(
    "docker",
    ["ps", "-a", "--filter", `name=^${name}$`, "--format", "{{.Names}}"],
    { timeoutMs: 15_000 },
  ).catch(() => ({ code: 1, stdout: "", stderr: "" }));
  return res.code === 0 && res.stdout.trim() === name;
}

/** Is the container still running? */
export async function localSandboxRunning(name: string): Promise<boolean> {
  const res = await run(
    "docker",
    ["inspect", "-f", "{{.State.Running}}", name],
    { timeoutMs: 15_000 },
  ).catch(() => ({ code: 1, stdout: "", stderr: "" }));
  return res.code === 0 && res.stdout.trim() === "true";
}

/** Stop the container — cheap pause; state (checkout, node_modules) stays. */
export async function pauseLocalSandbox(name: string): Promise<void> {
  const res = await run("docker", ["stop", name], { timeoutMs: 60_000 });
  if (res.code !== 0) {
    throw new Error(`docker stop failed: ${res.stderr.trim().slice(-200)}`);
  }
}

/**
 * Start a stopped sandbox container and bring its insides back: the
 * container's command is `sleep infinity`, so dockerd (DinD) and the stack
 * services do NOT restart on their own.
 */
export async function resumeLocalSandbox(
  name: string,
  opts: { onLog?: LogSink } = {},
): Promise<void> {
  const res = await run("docker", ["start", name], {
    onLog: opts.onLog,
    timeoutMs: 60_000,
  });
  if (res.code !== 0) {
    throw new Error(`docker start failed: ${res.stderr.trim().slice(-200)}`);
  }
  const revive = `
if command -v dockerd >/dev/null 2>&1 && [ ! -S /var/run/docker.sock ]; then
  nohup dockerd > /var/log/nexus-dockerd.log 2>&1 &
  for i in $(seq 1 30); do [ -S /var/run/docker.sock ] && break; sleep 1; done
fi
if [ -f /opt/nexus/stack/docker-compose.yml ] && command -v docker >/dev/null 2>&1; then
  (cd /opt/nexus/stack && docker compose up -d) || echo "[nexux] WARN: stack services failed to resume"
fi
echo "[nexux] resumed"`;
  await run("docker", ["exec", name, "bash", "-lc", revive], {
    onLog: opts.onLog,
    timeoutMs: 120_000,
  });
}

export async function destroyLocalSandbox(
  name: string,
  onLog?: LogSink,
): Promise<void> {
  onLog?.(`[nexux] removing container ${name}\n`);
  await run("docker", ["rm", "-f", name], { onLog, timeoutMs: 120_000 });
  // The DinD storage volume is sandbox-scoped: it dies with the sandbox.
  await run("docker", ["volume", "rm", `${name}-docker`], {
    timeoutMs: 60_000,
  }).catch(() => undefined);
}
