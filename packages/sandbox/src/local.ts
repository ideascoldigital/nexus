// Local sandboxes: the same bootstrap as a Civo instance, but inside a
// privileged Docker container on this machine (docker-in-docker so the stack
// services come up exactly like in the cloud). Exec goes through
// `docker exec` — see remote.ts's container transport.

import { spawn } from "child_process";
import fs from "fs/promises";
import os from "os";
import path from "path";
import {
  baseImageIsCurrent,
  renderBaseDockerfile,
  BASE_IMAGE_TAG,
  BASE_IMAGE_VERSION,
} from "./base-image";
import type { LogSink, SandboxSpec } from "./types";
import {
  BOOTSTRAP_COMPLETE_MARKER,
  BOOTSTRAP_FAILED_MARKER,
  renderCloudInit,
  safeSlug,
} from "./template";
import { DEFAULT_WS_PORT } from "./template-browser";
import { dockerHostArgs, type DockerTarget } from "./docker-endpoint";

/**
 * What a sandbox container starts from when nothing has been prebuilt.
 *
 * The bootstrap installs everything it needs on top of this, which is correct
 * and slow — see `resolveBaseImage` for the fast path (spec 24 piece 3).
 */
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
 * `docker …` against `target` — this machine's daemon when it is null, another
 * machine's over `-H ssh://…` otherwise (spec 26). Every docker call in this
 * file goes through here, so a sandbox cannot half-live on two daemons.
 */
function docker(
  target: DockerTarget | null | undefined,
  args: string[],
  opts: { onLog?: LogSink; timeoutMs?: number } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  return run("docker", [...dockerHostArgs(target), ...args], opts);
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

export async function sandboxMemoryLimitMb(
  target?: DockerTarget | null,
): Promise<number | null> {
  try {
    const res = await docker(target, ["info", "--format", "{{.MemTotal}}"], {
      timeoutMs: 15_000,
    });
    return memoryLimitFromTotalBytes(Number(res.stdout.trim()));
  } catch {
    return null;
  }
}

export async function dockerAvailable(
  target?: DockerTarget | null,
): Promise<boolean> {
  try {
    // Longer for a remote daemon: the first call pays the SSH handshake.
    const res = await docker(target, ["info"], {
      timeoutMs: target?.host ? 30_000 : 15_000,
    });
    return res.code === 0;
  } catch {
    return false;
  }
}

/**
 * The baked version label on a local image, or null when it is not there.
 *
 * `docker image inspect` rather than a tag check: a tag can be moved onto an
 * older image, and one that claims v1 while holding v0's tooling would make a
 * dry run answer for a machine that no longer exists.
 */
async function baseImageVersion(
  tag: string,
  target: DockerTarget | null | undefined,
): Promise<string | null> {
  try {
    const res = await docker(
      target,
      [
        "image",
        "inspect",
        tag,
        "--format",
        "{{ index .Config.Labels \"org.nexux.base-version\" }}",
      ],
      { timeoutMs: 20_000 },
    );
    if (res.code !== 0) return null;
    const label = res.stdout.trim();
    // `index` on a missing key prints "<no value>" rather than failing.
    return label && label !== "<no value>" ? label : null;
  } catch {
    return null;
  }
}

/**
 * Build the prebuilt base image (spec 24 piece 3).
 *
 * Exported so the UI can offer it as an explicit action: the build takes a few
 * minutes the first time, and a provision that silently stalled on it would be
 * indistinguishable from the slow bootstrap it exists to replace.
 */
export async function buildSandboxBaseImage(
  opts: { onLog?: LogSink; target?: DockerTarget | null } = {},
): Promise<{
  tag: string;
  built: boolean;
}> {
  const { onLog } = opts;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "nexux-base-"));
  try {
    await fs.writeFile(path.join(dir, "Dockerfile"), renderBaseDockerfile());
    onLog?.(`[nexux] building ${BASE_IMAGE_TAG} (first run takes a few minutes)\n`);
    // Over -H the build context is uploaded, so the image is built on — and
    // native to — the daemon that will run the sandboxes.
    const res = await docker(
      opts.target,
      ["build", "-t", BASE_IMAGE_TAG, "--label", `org.nexux.base-version=${BASE_IMAGE_VERSION}`, dir],
      { onLog, timeoutMs: 20 * 60_000 },
    );
    if (res.code !== 0) {
      throw new Error(
        `base image build failed: ${res.stderr.trim().slice(-400) || res.stdout.trim().slice(-400)}`,
      );
    }
    return { tag: BASE_IMAGE_TAG, built: true };
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Which image this launch should start from.
 *
 * Never builds on its own. A launch that quietly spent five minutes building
 * an image would be the same twenty-minute surprise this piece removes, only
 * with a different cause — so an absent or stale base falls back to
 * `ubuntu:22.04` and the bootstrap installs what it needs, exactly as before.
 * The caller decides when to pay for the build.
 */
export async function resolveBaseImage(
  opts: {
    preferPrebuilt?: boolean;
    onLog?: LogSink;
    target?: DockerTarget | null;
  } = {},
): Promise<{ image: string; prebuilt: boolean }> {
  if (!opts.preferPrebuilt) return { image: BASE_IMAGE, prebuilt: false };

  const version = await baseImageVersion(BASE_IMAGE_TAG, opts.target);
  if (version === null) {
    opts.onLog?.(
      `[nexux] no prebuilt base image — using ${BASE_IMAGE} (build one to make dry runs fast)\n`,
    );
    return { image: BASE_IMAGE, prebuilt: false };
  }
  if (!baseImageIsCurrent(version)) {
    opts.onLog?.(
      `[nexux] prebuilt base is v${version}, this build expects v${BASE_IMAGE_VERSION} — using ${BASE_IMAGE}\n`,
    );
    return { image: BASE_IMAGE, prebuilt: false };
  }
  opts.onLog?.(`[nexux] using prebuilt base ${BASE_IMAGE_TAG}\n`);
  return { image: BASE_IMAGE_TAG, prebuilt: true };
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
  /**
   * Start from the prebuilt base when one is current (spec 24 piece 3). Falls
   * back to ubuntu:22.04 when it is absent or stale — never builds inline.
   */
  preferPrebuilt?: boolean;
  /** Which daemon the container lives on; null/absent = this machine. */
  target?: DockerTarget | null;
}): Promise<{ containerName: string; prebuilt: boolean }> {
  const { name, spec, onLog, target } = opts;

  // A bind mount names a path on the daemon's machine, not this one. On a
  // remote daemon that is an empty directory Docker creates without a word —
  // a sandbox working on nothing. The launch route refuses this with a
  // friendlier message; this is the backstop.
  if (target?.host) {
    const unmountable = spec.repos.filter((r) => !r.repoUrl && r.mountPath);
    if (unmountable.length > 0) {
      throw new Error(
        `${target.host} can't see local folders (${unmountable.map((r) => r.name).join(", ")}) — give them a clone URL or run the sandbox on this machine.`,
      );
    }
  }

  const base = await resolveBaseImage({
    preferPrebuilt: opts.preferPrebuilt,
    onLog,
    target,
  });
  // Only the upstream image is pullable: the prebuilt one is local-only, and
  // `docker pull` on it fails against Docker Hub.
  if (!base.prebuilt) {
    onLog?.(`[nexux] pulling ${base.image}\n`);
    await docker(target, ["pull", base.image], { onLog, timeoutMs: 300_000 });
  }

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

  const memoryMb = await sandboxMemoryLimitMb(target);
  if (memoryMb) {
    onLog?.(`[nexux] memory limit ${memoryMb}m\n`);
  } else {
    onLog?.(`[nexux] WARN: no memory limit — a runaway build can take the host down\n`);
  }

  onLog?.(
    `[nexux] creating container ${name}${target?.host ? ` on ${target.host}` : ""}\n`,
  );
  const created = await docker(
    target,
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
      // The browser session's WebSocket bridge (spec 23). A cloud sandbox is
      // reached over an SSH forward; a container has no sshd, so the port has
      // to be published or the dashboard has nothing to connect to.
      //
      // The host side is left empty on purpose — docker picks a free port and
      // `browserWsPort()` reads it back. Pinning 6080 here would collide the
      // moment a second local sandbox runs. The 127.0.0.1 prefix is the part
      // that matters: an unbound VNC bridge is a browser holding this
      // machine's localhost, offered to the network.
      "-p",
      `127.0.0.1::${DEFAULT_WS_PORT}`,
      ...mounts,
      "--name",
      name,
      "--hostname",
      name,
      "--label",
      "nexux-sandbox=1",
      base.image,
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
  const staged = await docker(
    target,
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
  const kicked = await docker(
    target,
    ["exec", "-d", name, "bash", "/opt/nexus-bootstrap.sh"],
    { timeoutMs: 30_000 },
  );
  if (kicked.code !== 0) {
    throw new Error(
      `could not start bootstrap: ${kicked.stderr.trim().slice(-300)}`,
    );
  }

  return { containerName: name, prebuilt: base.prebuilt };
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Has the bootstrap finished? (completion marker written at the end.) */
export async function localBootstrapComplete(
  name: string,
  target?: DockerTarget | null,
): Promise<boolean> {
  const res = await docker(
    target,
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
  target?: DockerTarget | null,
): Promise<string | null> {
  const res = await docker(target, ["exec", name, "cat", BOOTSTRAP_FAILED_MARKER], {
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
export async function localContainerExists(
  name: string,
  target?: DockerTarget | null,
): Promise<boolean> {
  const res = await docker(
    target,
    ["ps", "-a", "--filter", `name=^${name}$`, "--format", "{{.Names}}"],
    { timeoutMs: 15_000 },
  ).catch(() => ({ code: 1, stdout: "", stderr: "" }));
  return res.code === 0 && res.stdout.trim() === name;
}

/** Is the container still running? */
export async function localSandboxRunning(
  name: string,
  target?: DockerTarget | null,
): Promise<boolean> {
  const res = await docker(
    target,
    ["inspect", "-f", "{{.State.Running}}", name],
    { timeoutMs: 15_000 },
  ).catch(() => ({ code: 1, stdout: "", stderr: "" }));
  return res.code === 0 && res.stdout.trim() === "true";
}

/**
 * The host port docker gave the browser session's WebSocket bridge, or null
 * when the container publishes none — a sandbox created before the port was
 * published keeps running without one, and a panel that cannot connect is
 * better than a wrong port that silently connects to something else.
 *
 * `docker port` prints one `host:port` line per binding (both IPv4 and IPv6
 * when both are bound), so the port is parsed off the end rather than by
 * splitting on ":" — an IPv6 host address carries colons of its own.
 */
export function parseDockerPort(stdout: string): number | null {
  for (const line of stdout.split("\n")) {
    const match = line.trim().match(/:(\d+)$/);
    if (!match) continue;
    const port = Number(match[1]);
    if (Number.isInteger(port) && port > 0 && port <= 65535) return port;
  }
  return null;
}

export async function browserWsPort(
  name: string,
  target?: DockerTarget | null,
): Promise<number | null> {
  const res = await docker(
    target,
    ["port", name, `${DEFAULT_WS_PORT}/tcp`],
    { timeoutMs: 15_000 },
  ).catch(() => ({ code: 1, stdout: "", stderr: "" }));
  if (res.code !== 0) return null;
  return parseDockerPort(res.stdout);
}

/** Stop the container — cheap pause; state (checkout, node_modules) stays. */
export async function pauseLocalSandbox(
  name: string,
  target?: DockerTarget | null,
): Promise<void> {
  const res = await docker(target, ["stop", name], { timeoutMs: 60_000 });
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
  opts: { onLog?: LogSink; target?: DockerTarget | null } = {},
): Promise<void> {
  const res = await docker(opts.target, ["start", name], {
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
  await docker(opts.target, ["exec", name, "bash", "-lc", revive], {
    onLog: opts.onLog,
    timeoutMs: 120_000,
  });
}

export async function destroyLocalSandbox(
  name: string,
  onLog?: LogSink,
  target?: DockerTarget | null,
): Promise<void> {
  onLog?.(`[nexux] removing container ${name}\n`);
  await docker(target, ["rm", "-f", name], { onLog, timeoutMs: 120_000 });
  // The DinD storage volume is sandbox-scoped: it dies with the sandbox.
  await docker(target, ["volume", "rm", `${name}-docker`], {
    timeoutMs: 60_000,
  }).catch(() => undefined);
}
