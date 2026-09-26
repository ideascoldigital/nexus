// Remote Docker endpoints (spec 26): another machine's daemon that local
// sandboxes can run on, reached as `docker -H ssh://…`.
//
// ssh:// only. The browser session is forwarded through the same SSH (a
// container publishes its VNC bridge on the remote's loopback), and plain
// tcp:// hands root on the remote to anyone who reaches the port.
import { spawn } from "child_process";

/** Where docker commands go. `host: null` is this machine's default daemon. */
export type DockerTarget = { host: string | null };

export type DockerHostError =
  | "empty"
  | "not-ssh"
  | "malformed"
  | "bad-port";

// user: POSIX-ish login names. host: a DNS name / IPv4, or a bracketed IPv6.
// Neither admits spaces, quotes or a leading "-", so the value can never pose
// as a flag to docker or ssh even though it is always passed as its own argv
// element anyway.
const SSH_HOST_RE =
  /^ssh:\/\/(?:([a-z_][a-z0-9_.-]{0,31})@)?([a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?|\[[0-9a-f:.]{2,45}\])(?::(\d{1,5}))?$/i;

/**
 * Validate and normalise an endpoint host as typed. Accepts
 * `ssh://[user@]host[:port]`; a trailing slash is forgiven, everything else
 * that is not exactly that shape is refused rather than repaired.
 */
export function parseDockerHost(
  raw: string,
): { ok: true; host: string } | { ok: false; error: DockerHostError } {
  const value = raw.trim().replace(/\/$/, "");
  if (!value) return { ok: false, error: "empty" };
  if (!/^ssh:\/\//i.test(value)) return { ok: false, error: "not-ssh" };
  const m = SSH_HOST_RE.exec(value);
  if (!m) return { ok: false, error: "malformed" };
  const [, user, hostname, port] = m;
  if (port !== undefined) {
    const n = Number(port);
    if (n < 1 || n > 65535) return { ok: false, error: "bad-port" };
  }
  const host = `ssh://${user ? `${user}@` : ""}${hostname.toLowerCase()}${port ? `:${Number(port)}` : ""}`;
  return { ok: true, host };
}

export function describeDockerHostError(error: DockerHostError): string {
  switch (error) {
    case "empty":
      return "A host is required.";
    case "not-ssh":
      return "Only ssh:// endpoints are supported — tcp:// exposes the daemon (root on that machine) to the network.";
    case "malformed":
      return "Expected ssh://user@host or ssh://user@host:port.";
    case "bad-port":
      return "The port must be between 1 and 65535.";
  }
}

/**
 * The argv prefix that points a docker command at `target`: `["-H", host]`,
 * or nothing for the default daemon. `-H` rather than DOCKER_HOST in the
 * env, so the destination is visible in argv and cannot leak into a child
 * that was never meant to see it.
 */
export function dockerHostArgs(target: DockerTarget | null | undefined): string[] {
  if (!target?.host) return [];
  const parsed = parseDockerHost(target.host);
  if (!parsed.ok) {
    throw new Error(`Refusing docker host ${JSON.stringify(target.host)}: ${parsed.error}`);
  }
  return ["-H", parsed.host];
}

/** What the probe reads out of `docker info`. */
export type DockerEndpointInfo = {
  serverVersion: string | null;
  arch: string | null;
  memTotalMb: number | null;
  rootless: boolean;
};

/** Parse `docker info --format '{{json .}}'`. Null when it is not JSON. */
export function parseDockerInfo(stdout: string): DockerEndpointInfo | null {
  let info: unknown;
  try {
    info = JSON.parse(stdout.trim());
  } catch {
    return null;
  }
  if (!info || typeof info !== "object") return null;
  const o = info as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" && v ? v : null);
  const mem = typeof o.MemTotal === "number" && o.MemTotal > 0
    ? Math.floor(o.MemTotal / (1024 * 1024))
    : null;
  const security = Array.isArray(o.SecurityOptions) ? o.SecurityOptions : [];
  return {
    serverVersion: str(o.ServerVersion),
    arch: str(o.Architecture),
    memTotalMb: mem,
    // Entries look like "name=rootless" (or plain "rootless" on old engines).
    rootless: security.some(
      (s) => typeof s === "string" && /(^|name=)rootless\b/.test(s),
    ),
  };
}

/**
 * Turn a failed probe's stderr into something the user can act on. The raw
 * tail always comes along — a hint is a guess, the stderr is the fact.
 */
export function explainProbeFailure(stderr: string): string {
  const tail = stderr.trim().split("\n").slice(-3).join("\n").slice(-400);
  const hints: Array<[RegExp, string]> = [
    [
      /permission denied while trying to connect to the docker daemon/i,
      "The SSH user can't talk to Docker there — add it to the docker group on that machine.",
    ],
    [
      /permission denied \((publickey|password|keyboard)/i,
      "SSH key authentication failed — this machine's key must be in that user's authorized_keys (password prompts are not supported).",
    ],
    [
      /host key verification failed/i,
      "The remote's host key isn't trusted yet — ssh to it once from a terminal to accept it.",
    ],
    [/could not resolve hostname/i, "The host name doesn't resolve from this machine."],
    [/connection refused/i, "Nothing is accepting SSH on that host and port."],
    [/(timed out|no route to host)/i, "The host didn't answer — is it on and reachable (LAN / tailnet)?"],
    [
      /(docker: (command )?not found|docker system dial-stdio)/i,
      "Docker isn't installed or isn't on the SSH user's PATH on that machine.",
    ],
    [/cannot connect to the docker daemon/i, "Docker is installed there but the daemon isn't running."],
  ];
  const hint = hints.find(([re]) => re.test(stderr))?.[1];
  if (!tail) return hint ?? "The probe failed without saying why.";
  return hint ? `${hint}\n${tail}` : tail;
}

export type ProbeResult =
  | ({ ok: true } & DockerEndpointInfo)
  | { ok: false; error: string };

type Runner = (
  bin: string,
  args: string[],
  timeoutMs: number,
) => Promise<{ code: number; stdout: string; stderr: string }>;

const PROBE_TIMEOUT_MS = 20_000;

/**
 * Spawned in its own session (`detached`), so ssh has no controlling
 * terminal to prompt on: a missing key fails in a second instead of hanging
 * on a password prompt in whatever terminal started the dev server.
 */
const defaultRunner: Runner = (bin, args, timeoutMs) =>
  new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, SSH_ASKPASS_REQUIRE: "never" },
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      stderr += `\n[nexux] timed out after ${timeoutMs / 1000}s`;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout.on("data", (c: Buffer) => (stdout += c.toString()));
    child.stderr.on("data", (c: Buffer) => (stderr += c.toString()));
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });

/**
 * Can local sandboxes run on this endpoint? One `docker info` over SSH
 * answers reachability, key auth, daemon access, and the facts the settings
 * list shows. Rootless daemons are refused: sandboxes need `--privileged`
 * for Docker-in-Docker, which rootless cannot grant.
 */
export async function probeDockerEndpoint(
  host: string,
  opts: { runner?: Runner; timeoutMs?: number } = {},
): Promise<ProbeResult> {
  const parsed = parseDockerHost(host);
  if (!parsed.ok) return { ok: false, error: describeDockerHostError(parsed.error) };

  const runner = opts.runner ?? defaultRunner;
  let res: { code: number; stdout: string; stderr: string };
  try {
    res = await runner(
      "docker",
      [...dockerHostArgs({ host: parsed.host }), "info", "--format", "{{json .}}"],
      opts.timeoutMs ?? PROBE_TIMEOUT_MS,
    );
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return {
      ok: false,
      error:
        code === "ENOENT"
          ? "The docker CLI isn't installed on this machine — it is what talks to the remote daemon."
          : err instanceof Error
            ? err.message
            : String(err),
    };
  }

  if (res.code !== 0) return { ok: false, error: explainProbeFailure(res.stderr) };

  const info = parseDockerInfo(res.stdout);
  if (!info) {
    return { ok: false, error: `Unexpected answer from docker info:\n${res.stdout.slice(0, 300)}` };
  }
  // `docker info` exits 0 even when it only reached the client half; a
  // missing server version means there was no daemon behind it.
  if (!info.serverVersion) {
    return { ok: false, error: explainProbeFailure(res.stderr) };
  }
  if (info.rootless) {
    return {
      ok: false,
      error:
        "That daemon runs rootless. Sandboxes need --privileged for Docker-in-Docker, which rootless Docker can't grant.",
    };
  }
  return { ok: true, ...info };
}
