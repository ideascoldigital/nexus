// Docker endpoints (spec 26): a daemon other than the one this machine's
// docker context points at, reached as `docker -H <host>`.
//
// Two shapes, and the difference is which machine the daemon's filesystem
// belongs to:
//
//   ssh://[user@]host[:port]  another machine. The browser session is
//                             forwarded through the same SSH, since a
//                             container publishes its bridge on the
//                             remote's loopback.
//   unix:///path/to.sock      a daemon on *this* machine behind its own
//                             socket — an orchestrator's dev cluster
//                             (litek8s, minikube, Colima) rather than
//                             whatever the docker context selects.
//
// Plain tcp:// stays refused: it hands root on that machine to anyone who
// reaches the port. A unix socket is not exposed to the network at all, so
// that argument does not apply to it.
import { spawn } from "child_process";

/** Where docker commands go. `host: null` is this machine's default daemon. */
export type DockerTarget = { host: string | null };

export type DockerHostError =
  | "empty"
  | "unsupported-scheme"
  | "malformed"
  | "bad-port"
  | "bad-socket-path";

// user: POSIX-ish login names. host: a DNS name / IPv4, or a bracketed IPv6.
// Neither admits spaces, quotes or a leading "-", so the value can never pose
// as a flag to docker or ssh even though it is always passed as its own argv
// element anyway.
// An absolute socket path. No whitespace or control characters, and it can
// never pose as a flag to docker because the scheme is always in front of it.
const UNIX_SOCKET_RE = /^unix:\/\/(\/[^\s\0]{0,1023})$/i;

const SSH_HOST_RE =
  /^ssh:\/\/(?:([a-z_][a-z0-9_.-]{0,31})@)?([a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?|\[[0-9a-f:.]{2,45}\])(?::(\d{1,5}))?$/i;

/**
 * Validate and normalise an endpoint host as typed. Accepts
 * `ssh://[user@]host[:port]` and `unix:///absolute/path.sock`; a trailing
 * slash is forgiven, everything else that is not exactly one of those shapes
 * is refused rather than repaired.
 */
export function parseDockerHost(
  raw: string,
): { ok: true; host: string } | { ok: false; error: DockerHostError } {
  const trimmed = raw.trim();
  if (!trimmed) return { ok: false, error: "empty" };
  // The scheme is read before a trailing slash is forgiven, so a bare
  // "unix://" is a missing path rather than an unknown scheme.
  const value = trimmed.replace(/\/$/, "");
  if (/^unix:\/\//i.test(trimmed)) {
    const sock = UNIX_SOCKET_RE.exec(value);
    // The path is the endpoint's identity, so it is kept exactly as typed —
    // only the scheme is lowercased.
    return sock
      ? { ok: true, host: `unix://${sock[1]}` }
      : { ok: false, error: "bad-socket-path" };
  }
  if (!/^ssh:\/\//i.test(value)) return { ok: false, error: "unsupported-scheme" };
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

/**
 * The pieces of an endpoint host, for tools that take them apart — the
 * browser session's `ssh -L` forward (spec 26 phase 3). Null when the host is
 * not a valid endpoint.
 */
export function sshUrlParts(
  raw: string,
): { user: string | null; hostname: string; port: number | null } | null {
  const parsed = parseDockerHost(raw);
  if (!parsed.ok) return null;
  const m = SSH_HOST_RE.exec(parsed.host);
  // A unix socket parses fine and has no ssh parts at all.
  if (!m) return null;
  return {
    user: m[1] ?? null,
    // ssh takes an IPv6 literal bare, not bracketed as in a URL.
    hostname: m[2].replace(/^\[|\]$/g, ""),
    port: m[3] ? Number(m[3]) : null,
  };
}

/**
 * Whose filesystem the daemon behind `host` has. This is the question that
 * decides everything else: a `local` daemon can be handed a path from this
 * machine and may publish a container's port on this machine's loopback, a
 * `remote` one cannot — its paths and its ports are its own, which is why a
 * remote sandbox clones a repo instead of mounting it and why its browser
 * session needs an SSH forward.
 *
 * No host at all is local: that is the daemon this machine's docker context
 * already points at. Null means the host does not parse.
 */
export function dockerHostKind(
  host: string | null | undefined,
): "local" | "remote" | null {
  if (!host) return "local";
  const parsed = parseDockerHost(host);
  if (!parsed.ok) return null;
  return parsed.host.toLowerCase().startsWith("ssh://") ? "remote" : "local";
}

export function describeDockerHostError(error: DockerHostError): string {
  switch (error) {
    case "empty":
      return "A host is required.";
    case "unsupported-scheme":
      return "Only ssh:// (another machine) and unix:// (a socket on this one) are supported — tcp:// exposes the daemon, which is root on that machine, to the network.";
    case "malformed":
      return "Expected ssh://user@host or ssh://user@host:port.";
    case "bad-port":
      return "The port must be between 1 and 65535.";
    case "bad-socket-path":
      return "Expected unix:// followed by an absolute path, like unix:///var/run/docker.sock.";
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
 *
 * `host` is optional and only selects which hints can apply: the same
 * "connection refused" means a closed SSH port on one kind of endpoint and a
 * dead daemon behind a socket on the other, so the socket hints go in front
 * when the endpoint is one.
 */
export function explainProbeFailure(stderr: string, host?: string): string {
  const tail = stderr.trim().split("\n").slice(-3).join("\n").slice(-400);
  const socket: Array<[RegExp, string]> =
    host && dockerHostKind(host) === "local" && /^unix:\/\//i.test(host.trim())
      ? [
          [
            /no such file or directory|cannot connect to the docker daemon at unix:/i,
            "There is nothing listening on that socket. If it belongs to a dev cluster (litek8s, minikube, Colima), start the cluster first — the socket only exists while it runs.",
          ],
          [
            /connection refused/i,
            "The socket is there but the daemon behind it is not answering.",
          ],
          [
            /permission denied/i,
            "This user cannot open that socket — check its owner and mode.",
          ],
        ]
      : [];
  const hints: Array<[RegExp, string]> = [
    ...socket,
    [
      /permission denied while trying to connect to the docker daemon/i,
      "The SSH user can't talk to Docker there — add it to the docker group on that machine.",
    ],
    [
      /permission denied \((publickey|password|keyboard)/i,
      "SSH key authentication failed — this machine's key must be in that user's authorized_keys (password prompts are not supported).",
    ],
    // Before the generic verification failure: a *changed* key is either a
    // reinstalled machine or someone in the middle, and only the user can
    // tell which — so say what changed and how to clear it, never accept it.
    [
      /remote host identification has changed|host key for .* has changed/i,
      "The remote's host key changed since this machine last connected. If you reinstalled it, remove the old key (ssh-keygen -R <host>) and ssh to it once to accept the new one; if you didn't, don't.",
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

  if (res.code !== 0) {
    return { ok: false, error: explainProbeFailure(res.stderr, parsed.host) };
  }

  const info = parseDockerInfo(res.stdout);
  if (!info) {
    return { ok: false, error: `Unexpected answer from docker info:\n${res.stdout.slice(0, 300)}` };
  }
  // `docker info` exits 0 even when it only reached the client half; a
  // missing server version means there was no daemon behind it.
  if (!info.serverVersion) {
    return { ok: false, error: explainProbeFailure(res.stderr, parsed.host) };
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

/**
 * `docker build` leaves the image in a daemon's store only when the active
 * buildx builder uses the `docker` driver. A `docker-container` builder —
 * what `docker buildx create` gives you, and what a dev cluster can leave
 * selected — keeps the result in the build cache instead and only warns about
 * it on stderr. The build then "succeeds", `docker run` finds no such image,
 * falls back to Docker Hub and fails with a 401 on a name that was never
 * published there.
 *
 * `--load` moves the result into the store. It is a no-op for the `docker`
 * driver and unknown to the pre-buildx builder, so a build that is refused
 * for the flag is retried without it rather than failing on an older Docker.
 */
export const LOAD_FLAG = "--load";

export const IMAGE_NOT_IN_STORE =
  "the image built but is not in this daemon's image store — its buildx builder is probably a " +
  '"docker-container" one, which keeps the result in the build cache. Select a builder that ' +
  "loads: docker buildx use default";

/** Did docker reject the flag itself, rather than fail the build? */
export function rejectedBuildFlag(stderr: string): boolean {
  return /unknown flag|flag provided but not defined|unknown shorthand/i.test(stderr);
}
