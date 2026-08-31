import fs from "fs";
import path from "path";
import http from "http";
import { WebSocketServer, WebSocket } from "ws";
import * as pty from "node-pty";
import { getConfig } from "@nexux/config";
import { defaultShellId, parseShellId, spawnPlan } from "./shells";

export interface TerminalServerHandle {
  port: number;
  close: () => Promise<void>;
}

/**
 * The unprivileged user that owns the checkouts under /opt/nexus on a sandbox.
 * Mirrors AGENT_USER in @nexux/sandbox — duplicated rather than imported so
 * this package keeps no dependency on the sandbox package.
 */
const SANDBOX_USER = "nexus";

/**
 * How long to wait for a remote that is not answering. OpenSSH applies
 * `ConnectTimeout` to the banner exchange as well as the TCP connect, which is
 * the case that actually bites: a stopped or wedged sandbox still completes the
 * handshake, so without this ssh sits through its 120-second banner default and
 * the pane looks frozen rather than failed. 15s matches `execRemote` in
 * @nexux/sandbox, which has always had it — the terminal was the one ssh caller
 * that did not.
 */
const SSH_CONNECT_TIMEOUT = 15;

/**
 * The ssh invocation for a remote session. Pure, so the flags can be asserted
 * without a reachable host — the interesting cases here are precisely the ones
 * that never connect.
 */
export function sshLaunchArgs(
  target: string,
  remotePath: string,
  opts: { knownHostsFile: string; identityFile?: string },
): string[] {
  const args = [
    "-o",
    "StrictHostKeyChecking=accept-new",
    "-o",
    `UserKnownHostsFile=${opts.knownHostsFile}`,
    "-o",
    `ConnectTimeout=${SSH_CONNECT_TIMEOUT}`,
    // A session that dies mid-flight (instance stopped, laptop off the tailnet)
    // otherwise hangs until TCP gives up, which can be many minutes.
    "-o",
    "ServerAliveInterval=15",
    "-o",
    "ServerAliveCountMax=3",
  ];
  // Nexus's sandbox keypair (registered on every sandbox instance) makes the
  // session password-less. IdentitiesOnly stops ssh from offering every
  // agent-loaded key first — a loaded agent exhausts the server's
  // MaxAuthTries ("Too many authentication failures") before this key is
  // ever tried.
  if (opts.identityFile) {
    args.push("-i", opts.identityFile, "-o", "IdentitiesOnly=yes");
  }
  if (remotePath) {
    // -t forces a tty since we pass a remote command; fall back to the home
    // dir if the path doesn't exist yet (e.g. bootstrap still cloning).
    args.push("-t", target, `cd '${remotePath}' 2>/dev/null; exec bash -l`);
  } else {
    args.push(target);
  }
  return args;
}

/**
 * Start the terminal WebSocket server (node-pty backed). Returns a handle so the
 * caller can shut it down. Has no module-level side effects — call it from the
 * Next sidecar (start.js) in prod, or from the CLI entry below in dev.
 */
/** Queue a socket may hold before the pty is told to stop producing. */
export const PAUSE_ABOVE_BYTES = 4 * 1024 * 1024;

/** Queue it must drain back to before the pty resumes. */
export const RESUME_BELOW_BYTES = 512 * 1024;

/**
 * Whether a pty should be paused, resumed, or left alone for the amount its
 * socket still has queued.
 *
 * The two thresholds are deliberately far apart. A single mark would flap: the
 * pty resumes, immediately refills the queue past the same line, and pauses
 * again — thousands of times a second on a chatty program, which costs more
 * than the buffering it was meant to prevent. Draining to an eighth of the
 * pause mark buys a real window of streaming between decisions.
 */
export function backpressureAction(
  bufferedBytes: number,
  paused: boolean,
): "pause" | "resume" | "none" {
  if (!paused) return bufferedBytes > PAUSE_ABOVE_BYTES ? "pause" : "none";
  return bufferedBytes <= RESUME_BELOW_BYTES ? "resume" : "none";
}

export function startTerminalServer(): TerminalServerHandle {
  const PORT = Number(process.env.NEXUX_TERMINAL_PORT ?? 3002);
  const CORS_ORIGIN = process.env.NEXUX_WEB_ORIGIN ?? "http://localhost:3000";
  const { shell: shellConfig } = getConfig();

  const server = http.createServer((req, res) => {
    res.setHeader("Access-Control-Allow-Origin", CORS_ORIGIN);
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }
    res.writeHead(404);
    res.end();
  });

  const wss = new WebSocketServer({ server });

  wss.on("connection", (ws: WebSocket, req) => {
  const url = new URL(req.url || "", "ws://localhost");
  const cwd = url.searchParams.get("cwd") || shellConfig.home;
  const cols = parseInt(url.searchParams.get("cols") || "80", 10) || 80;
  const rows = parseInt(url.searchParams.get("rows") || "24", 10) || 24;
  // Which shell to run is per-session, not per-machine: Windows has cmd,
  // PowerShell and one entry per WSL distro, and a project can live in any of
  // them. An unknown id (state restored from another machine, a distro since
  // removed) resolves to this machine's default rather than failing to spawn.
  const requestedShell = url.searchParams.get("shell");
  const shellSpec = parseShellId(requestedShell);
  const shellUnavailable = Boolean(
    requestedShell && requestedShell !== shellSpec.id,
  );

  // A cwd of "ssh://user@host[/remote/path]" opens a remote session instead of
  // a local shell (used for sandbox instances), landing in the remote path
  // when given. Strict charsets — first char of user and host must be
  // alphanumeric and the path allows no quotes/spaces, so neither can be
  // parsed as an ssh flag or escape the shell quoting below.
  const sshMatch = cwd.match(
    /^ssh:\/\/([a-z0-9][a-z0-9._-]*@[a-z0-9][a-z0-9.-]*)((?:\/[a-z0-9._-]+)*)\/?$/i,
  );
  const sshTarget = sshMatch?.[1];
  const sshPath = sshMatch?.[2] || "";

  // A cwd of "docker://<container>[/path]" attaches to a local sandbox
  // container instead. Local sandboxes have no public IP, so ssh is not an
  // option — `docker exec` is the equivalent entry point. Same strict charset
  // reasoning as above: Docker names are [a-zA-Z0-9][a-zA-Z0-9_.-]* and the
  // path allows no quotes/spaces, so neither can pose as a flag or break out
  // of the shell quoting below.
  const dockerMatch = cwd.match(
    /^docker:\/\/([a-z0-9][a-z0-9._-]*)((?:\/[a-z0-9._-]+)*)\/?$/i,
  );
  const dockerContainer = sshTarget ? undefined : dockerMatch?.[1];
  const dockerPath = dockerMatch?.[2] || "";

  const remote = sshTarget || dockerContainer;

  console.log(
    sshTarget
      ? `[terminal] New SSH session: ${sshTarget}${sshPath} ${cols}x${rows}`
      : dockerContainer
        ? `[terminal] New docker exec session: ${dockerContainer}${dockerPath} ${cols}x${rows}`
        : `[terminal] New connection: shell=${shellSpec.id} cwd=${cwd} ${cols}x${rows}`,
  );

  // The requested cwd may not exist on this machine — e.g. a nexus host whose
  // picker entries carry paths from another install. node-pty aborts the
  // session with "chdir(2) failed" on a missing cwd, so fall back to the home
  // dir (matching the `cd … 2>/dev/null` tolerance of the ssh/docker branches)
  // and tell the user below.
  // A WSL cwd is resolved *inside* the distro, so a path Windows cannot see is
  // normal (`/home/you`, or a project reached through \\wsl.localhost) and the
  // `cd` in the launch command already tolerates a missing one. Only check the
  // filesystem for shells that actually run on this side.
  const localCwdMissing =
    !remote && shellSpec.kind !== "wsl" && !fs.existsSync(cwd);
  const spawnCwd = remote || localCwdMissing ? shellConfig.home : cwd;
  const spawnOpts = {
    name: "xterm-256color",
    cols,
    rows,
    cwd: spawnCwd,
    env: {
      ...process.env,
      TERM: "xterm-256color",
      COLORTERM: "truecolor",
    },
  };

  // Host keys go next to the sandbox key, not ~/.ssh: on a Nexus host the
  // container's uid has no home dir, so the default known_hosts is
  // unwritable — every session would warn and accept-new could never pin.
  const sandboxKey = path.join(getConfig().dataDir, "ssh", "id_ed25519");
  const sshArgs = sshTarget
    ? sshLaunchArgs(sshTarget, sshPath, {
        knownHostsFile: path.join(getConfig().dataDir, "ssh", "known_hosts"),
        identityFile: fs.existsSync(sandboxKey) ? sandboxKey : undefined,
      })
    : [];

  // -it for an interactive tty; fall back to the container's default cwd if
  // the path isn't there yet (bootstrap may still be cloning), same as the ssh
  // branch. The outer shell is `-c`, not `-lc`: as a login shell it lands the
  // session in / and the cd is lost. The inner `exec bash -l` still gives an
  // interactive login shell, and it inherits the cwd we just set.
  // -u nexus, not root: the checkouts under /opt/nexus belong to the agent
  // user, and anything this session builds there (node_modules, .next, dist)
  // would otherwise land root-owned and break the dev servers and the agent
  // that run as nexux. `sudo` is passwordless here for the rare root step.
  const dockerArgs = dockerContainer
    ? [
        "exec",
        "-it",
        "-u",
        SANDBOX_USER,
        dockerContainer,
        "bash",
        "-c",
        `cd '${dockerPath || "/opt/nexus"}' 2>/dev/null; exec bash -l`,
      ]
    : [];

  // WSL gets the untouched cwd — `spawnPlan` translates it to the distro's view
  // (E:\x → /mnt/e/x, \\wsl.localhost\d\x → /x) — and launches from the Windows
  // home, which node-pty can always chdir to.
  const plan = spawnPlan(
    shellSpec,
    shellSpec.kind === "wsl" ? cwd : spawnCwd,
  );

  const term = sshTarget
    ? pty.spawn("ssh", sshArgs, spawnOpts)
    : dockerContainer
      ? pty.spawn("docker", dockerArgs, spawnOpts)
      : pty.spawn(plan.file, plan.args, {
          ...spawnOpts,
          cwd: plan.cwd ?? shellConfig.home,
        });

  // A remote session shows nothing until ssh has a shell, so an unreachable box
  // is an empty pane for as long as the connect takes. Name the target up front
  // — then the wait reads as a wait, and the error below attaches to something.
  if (remote) {
    ws.send(`\x1b[2m[connecting to ${remote}…]\x1b[0m\r\n`);
  }

  if (localCwdMissing) {
    ws.send(
      `\x1b[33m[cwd not found on this machine: ${cwd} — starting in ${shellConfig.home}]\x1b[0m\r\n`,
    );
  }

  if (shellUnavailable) {
    ws.send(
      `\x1b[33m[shell "${requestedShell}" is not available on this machine — using ${shellSpec.label}]\x1b[0m\r\n`,
    );
  }

  // Backpressure between the pty and the socket.
  //
  // A pty produces far faster than a WebSocket drains — a build, a `tail -f`,
  // or simply a backgrounded browser tab is enough. `ws` queues whatever it
  // cannot flush, in memory, with no ceiling: an unbounded producer wired to
  // an unbounded queue. Measured at roughly 1 GB of retained heap per open
  // session, which is what pushed the dev server past Next's memory threshold
  // and made it restart — killing whatever agent task was running at the time.
  //
  // Pausing the pty pushes the backlog where it belongs: the kernel's pipe
  // buffer, and then the producing program, which blocks. Output is delayed,
  // never dropped.
  let paused = false;

  const resumeWhenDrained = () => {
    if (!paused) return;
    if (ws.readyState !== WebSocket.OPEN) return; // close handler kills the pty
    if (backpressureAction(ws.bufferedAmount, paused) === "resume") {
      paused = false;
      term.resume();
      return;
    }
    setTimeout(resumeWhenDrained, 25);
  };

  term.onData((data) => {
    if (ws.readyState !== WebSocket.OPEN) return;
    ws.send(data);
    if (backpressureAction(ws.bufferedAmount, paused) === "pause") {
      paused = true;
      term.pause();
      setTimeout(resumeWhenDrained, 25);
    }
  });

  term.onExit(({ exitCode, signal }) => {
    console.log(`[terminal] Shell exited: code=${exitCode} signal=${signal}`);
    if (ws.readyState === WebSocket.OPEN) {
      // 255 is ssh's "never got a session". Its own message is already on
      // screen, but on its own it reads as Nexus being broken — say which box
      // did not answer, and that the box is the thing to go look at.
      if (sshTarget && exitCode === 255) {
        ws.send(
          `\x1b[31m[${sshTarget} did not accept a session — it may be starting, stopped, or unreachable from this machine]\x1b[0m\r\n`,
        );
      }
      ws.close();
    }
  });

  ws.on("message", (msg: Buffer) => {
    const str = msg.toString("utf8");
    if (str.length > 0 && str.charCodeAt(0) === 0x7b) {
      try {
        const obj = JSON.parse(str);
        if (obj?.type === "resize" && Number.isFinite(obj.cols) && Number.isFinite(obj.rows)) {
          term.resize(Math.max(1, obj.cols | 0), Math.max(1, obj.rows | 0));
          return;
        }
      } catch {
        // not JSON — fall through to write
      }
    }
    term.write(str);
  });

  const killTerm = () => {
    try {
      term.kill();
    } catch {
      // already dead
    }
  };

  let alive = true;
  ws.on("pong", () => {
    alive = true;
  });
  const heartbeat = setInterval(() => {
    if (!alive) {
      ws.terminate();
      return;
    }
    alive = false;
    try {
      ws.ping();
    } catch {
      // ignore
    }
  }, 30_000);

  ws.on("close", () => {
    console.log("[terminal] WebSocket closed");
    clearInterval(heartbeat);
    killTerm();
  });

  ws.on("error", (err: Error) => {
    console.error("[terminal] WebSocket error:", err.message);
    clearInterval(heartbeat);
    killTerm();
  });
});

  server.listen(PORT, () => {
    console.log(`[terminal] Server listening on ws://localhost:${PORT}`);
    console.log(`[terminal] Default shell: ${defaultShellId()}`);
  });

  const close = () =>
    new Promise<void>((resolve) => {
      wss.close();
      server.close(() => resolve());
    });

  return { port: PORT, close };
}

// CLI entry: `tsx terminal-server.ts` (dev:terminal / start:terminal). Running
// the file directly starts the server and wires SIGTERM. Importing the module
// does nothing until startTerminalServer() is called.
const isMain =
  typeof require !== "undefined" && require.main === module;
if (isMain) {
  const handle = startTerminalServer();
  process.on("SIGTERM", () => {
    console.log("[terminal] Shutting down");
    handle.close().then(() => process.exit(0));
  });
}
