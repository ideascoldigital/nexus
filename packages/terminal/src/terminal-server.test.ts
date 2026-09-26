import { strict as assert } from "node:assert";
import { after, before, test } from "node:test";
import fs from "fs";
import http from "http";
import os from "os";
import path from "path";
import { WebSocket } from "ws";

import type { TerminalServerHandle } from "./terminal-server";
import {
  PAUSE_ABOVE_BYTES,
  RESUME_BELOW_BYTES,
  backpressureAction,
} from "./terminal-server";

// Asked of the OS rather than fixed: `turbo run test test:coverage` runs this
// file twice at once, and two runs binding one port means whichever loses the
// race fails on EADDRINUSE — surfacing as a scatter of unrelated-looking
// failures (a 404 assertion, a websocket close code) rather than as a bind
// error. Binding :0 and reading back what was granted is the only way to get a
// port nothing else holds; deriving one from the pid still collides, since
// nothing stops two pids from mapping to the same number.
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = http.createServer();
    probe.once("error", reject);
    probe.listen(0, "localhost", () => {
      const addr = probe.address();
      if (typeof addr === "string" || addr === null) {
        probe.close(() => reject(new Error("no port was assigned")));
        return;
      }
      // Closed before the real server binds it. A third party could take the
      // port in that window, but nothing else on this machine is asking the
      // kernel for ephemeral ports in a tight loop, and the alternative —
      // a fixed number — collides every time rather than almost never.
      probe.close(() => resolve(addr.port));
    });
  });
}

let PORT: number;
const ORIGIN = "http://test-origin.local";

// The session tests drive a real pty and assert POSIX shell behaviour â€” `pwd`,
// `stty size`, brace grouping, `$SHELL`. Windows has no POSIX shell to hold
// them up (that is the whole reason shells.ts exists), and a session that never
// echoes what they wait for hangs the run rather than failing it. Their
// platform-independent halves live in shells.test.ts, which does run here.
const posixShell = {
  skip:
    process.platform === "win32" &&
    "asserts POSIX shell behaviour; see shells.test.ts",
};

let handle: TerminalServerHandle;
let cwd: string;

before(async () => {
  PORT = await freePort();
  process.env.NEXUX_TERMINAL_PORT = String(PORT);
  process.env.NEXUX_WEB_ORIGIN = ORIGIN;
  process.env.SHELL = "/bin/sh";
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), "nexux-term-"));
  // Server reads config at call time; import after env is set for safety.
  const { startTerminalServer } = await import("./terminal-server");
  // One known endpoint, pointing somewhere that cannot resolve: enough to see
  // the session handed to docker with -H, without a daemon to reach.
  handle = startTerminalServer({
    resolveDockerHost: async (id) =>
      id === "ep1" ? "ssh://nobody@nexux-test.invalid" : null,
  });
  await new Promise((r) => setTimeout(r, 100));
});

after(async () => {
  await handle.close();
  fs.rmSync(cwd, { recursive: true, force: true });
});

function request(method: string, urlPath = "/"): Promise<http.IncomingMessage> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "localhost", port: PORT, method, path: urlPath },
      (res) => {
        res.resume();
        res.on("end", () => resolve(res));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

interface Session {
  ws: WebSocket;
  output: () => string;
  waitFor: (pattern: RegExp, timeoutMs?: number) => Promise<void>;
}

function connect(params: Record<string, string>): Promise<Session> {
  const qs = new URLSearchParams(params).toString();
  const ws = new WebSocket(`ws://localhost:${PORT}/?${qs}`);
  let buf = "";
  ws.on("message", (d) => {
    buf += d.toString();
  });
  const session: Session = {
    ws,
    output: () => buf,
    waitFor: (pattern, timeoutMs = 5000) =>
      new Promise((resolve, reject) => {
        const started = Date.now();
        const timer = setInterval(() => {
          if (pattern.test(buf)) {
            clearInterval(timer);
            resolve();
          } else if (Date.now() - started > timeoutMs) {
            clearInterval(timer);
            reject(new Error(`timed out waiting for ${pattern}; got: ${buf.slice(-500)}`));
          }
        }, 50);
      }),
  };
  return new Promise((resolve, reject) => {
    ws.on("open", () => resolve(session));
    ws.on("error", reject);
  });
}

test("handle reports the configured port", () => {
  assert.equal(handle.port, PORT);
});

test("HTTP GET returns 404 with the configured CORS origin", async () => {
  const res = await request("GET");
  assert.equal(res.statusCode, 404);
  assert.equal(res.headers["access-control-allow-origin"], ORIGIN);
});

test("HTTP OPTIONS preflight returns 204", async () => {
  const res = await request("OPTIONS");
  assert.equal(res.statusCode, 204);
});

test("websocket session spawns a shell in the requested cwd", posixShell, async () => {
  const s = await connect({ cwd, cols: "80", rows: "24" });
  s.ws.send("pwd\n");
  // /tmp is a symlink to /private/tmp on macOS â€” match on the unique basename.
  await s.waitFor(new RegExp(path.basename(cwd)));
  s.ws.close();
});

test("resize control message adjusts the pty size", posixShell, async () => {
  const s = await connect({ cwd, cols: "80", rows: "24" });
  s.ws.send(JSON.stringify({ type: "resize", cols: 100, rows: 40 }));
  await new Promise((r) => setTimeout(r, 200));
  s.ws.send("stty size\n");
  await s.waitFor(/40 100/);
  s.ws.close();
});

test("brace-prefixed non-JSON input falls through to the shell", posixShell, async () => {
  const s = await connect({ cwd, cols: "80", rows: "24" });
  s.ws.send('{ echo "br""ace-ok"; }\n');
  await s.waitFor(/brace-ok/);
  s.ws.close();
});

test("invalid cols/rows fall back to 80x24", posixShell, async () => {
  const s = await connect({ cwd, cols: "banana", rows: "" });
  s.ws.send("stty size\n");
  await s.waitFor(/24 80/);
  s.ws.close();
});

// A container name outside [a-z0-9][a-z0-9._-]* must not reach `docker exec`,
// or the shell metacharacters in it would run on the host. Rejected names fall
// through to the plain local-shell branch instead.
test("malformed docker:// cwd does not spawn docker exec", posixShell, async () => {
  const s = await connect({
    cwd: `docker://bad;name/opt/nexus`,
    cols: "80",
    rows: "24",
  });
  // It falls through to the local-shell branch, whose missing-cwd fallback
  // opens a shell in the home dir with a warning â€” proving the request never
  // reached docker (a docker branch would print "No such container" instead).
  await s.waitFor(/cwd not found on this machine/);
  assert.ok(
    !/No such container/i.test(s.output()),
    `expected no docker session; got: ${s.output().slice(-300)}`,
  );
  s.ws.close();
});

// Picker entries can carry paths from another install (e.g. a nexus host shown
// a laptop's repo paths). node-pty would abort with "chdir(2) failed" â€” the
// server must fall back to the home dir and keep the session alive.
test("nonexistent local cwd falls back to the home dir with a warning", posixShell, async () => {
  const missing = path.join(cwd, "does-not-exist");
  const s = await connect({ cwd: missing, cols: "80", rows: "24" });
  await s.waitFor(/cwd not found on this machine/);
  s.ws.send("pwd\n");
  await s.waitFor(new RegExp(os.homedir().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  s.ws.close();
});

// Well-formed names take the docker branch. Docker itself may be absent in CI,
// so assert on the attempt (docker's own output/error), not on a live session.
test("well-formed docker:// cwd routes to the docker branch", posixShell, async () => {
  const s = await connect({
    cwd: `docker://nexux-does-not-exist-${process.pid}/opt/nexus`,
    cols: "80",
    rows: "24",
  });
  // Either docker replies "No such container" or the binary is missing â€” both
  // prove the request was handed to docker rather than to a local shell.
  await s.waitFor(/No such container|Cannot connect to the Docker daemon|not found|ENOENT/i);
  s.ws.close();
});

// --- ssh launch flags -------------------------------------------------------

// A remote that accepts TCP but never sends its banner — a stopped or wedged
// sandbox — is the case that hurt: ssh's banner default is 120 seconds, so the
// pane sat blank long enough to read as a broken feature rather than a dead
// box. OpenSSH applies ConnectTimeout to the banner exchange too, which is why
// setting it is the fix. Asserted on the flags rather than a live connection:
// the whole point is a host that never answers.
test("a remote session carries a connect timeout and keepalives", async () => {
  const { sshLaunchArgs } = await import("./terminal-server");
  const args = sshLaunchArgs("nexus@10.0.0.1", "", {
    knownHostsFile: "/data/ssh/known_hosts",
  });
  assert.ok(args.includes("ConnectTimeout=15"), args.join(" "));
  assert.ok(args.includes("ServerAliveInterval=15"), args.join(" "));
  assert.ok(args.includes("ServerAliveCountMax=3"), args.join(" "));
});

test("without a path the target is the last argument, with no remote command", async () => {
  const { sshLaunchArgs } = await import("./terminal-server");
  const args = sshLaunchArgs("root@100.64.0.1", "", {
    knownHostsFile: "/data/ssh/known_hosts",
  });
  assert.equal(args.at(-1), "root@100.64.0.1");
  assert.ok(!args.includes("-t"));
});

// -t is required because a remote command is passed; the cd tolerates a path
// that does not exist yet (bootstrap may still be cloning).
test("a path becomes a tolerant cd behind a forced tty", async () => {
  const { sshLaunchArgs } = await import("./terminal-server");
  const args = sshLaunchArgs("nexus@10.0.0.1", "/opt/nexus", {
    knownHostsFile: "/data/ssh/known_hosts",
  });
  assert.ok(args.includes("-t"));
  assert.equal(args.at(-2), "nexus@10.0.0.1");
  assert.equal(args.at(-1), "cd '/opt/nexus' 2>/dev/null; exec bash -l");
});

// A loaded ssh-agent exhausts the server's MaxAuthTries before Nexus's own key
// is offered, so IdentitiesOnly must ride along with -i — never on its own.
test("the identity file is offered exclusively, and only when there is one", async () => {
  const { sshLaunchArgs } = await import("./terminal-server");
  const base = { knownHostsFile: "/data/ssh/known_hosts" };
  const without = sshLaunchArgs("nexus@10.0.0.1", "", base);
  assert.ok(!without.includes("IdentitiesOnly=yes"));
  assert.ok(!without.includes("-i"));

  const withKey = sshLaunchArgs("nexus@10.0.0.1", "", {
    ...base,
    identityFile: "/data/ssh/id_ed25519",
  });
  assert.equal(withKey[withKey.indexOf("-i") + 1], "/data/ssh/id_ed25519");
  assert.ok(withKey.includes("IdentitiesOnly=yes"));
});

// --- backpressure ------------------------------------------------------------
// A pty produces far faster than a WebSocket drains, and `ws` queues whatever
// it cannot flush in memory with no ceiling. Measured at ~1 GB of retained heap
// per open session, which pushed the dev server past Next's memory threshold —
// and every restart it triggered killed the agent task that was running.

test("a quiet socket leaves the pty alone", () => {
  assert.equal(backpressureAction(0, false), "none");
  assert.equal(backpressureAction(1024, false), "none");
});

test("the pty is paused only once the queue passes the high mark", () => {
  assert.equal(backpressureAction(PAUSE_ABOVE_BYTES, false), "none");
  assert.equal(backpressureAction(PAUSE_ABOVE_BYTES + 1, false), "pause");
});

test("a paused pty is not asked to pause again", () => {
  assert.equal(backpressureAction(PAUSE_ABOVE_BYTES * 10, true), "none");
});

test("resuming waits for a real drain, not a dip below the pause mark", () => {
  // The whole point of the second threshold: dropping just under the pause
  // line would resume into an almost-full queue and pause again immediately.
  assert.equal(backpressureAction(PAUSE_ABOVE_BYTES - 1, true), "none");
  assert.equal(backpressureAction(RESUME_BELOW_BYTES + 1, true), "none");
  assert.equal(backpressureAction(RESUME_BELOW_BYTES, true), "resume");
});

test("an empty queue resumes", () => {
  assert.equal(backpressureAction(0, true), "resume");
});

test("the thresholds leave a wide hysteresis band", () => {
  // Narrow marks flap thousands of times a second on a chatty program, which
  // costs more than the buffering they replace.
  assert.ok(
    RESUME_BELOW_BYTES * 4 < PAUSE_ABOVE_BYTES,
    "resume mark is far below the pause mark",
  );
});

test("no queue size ever asks for both actions", () => {
  for (const n of [0, 1, RESUME_BELOW_BYTES, PAUSE_ABOVE_BYTES, 1 << 30]) {
    const running = backpressureAction(n, false);
    const held = backpressureAction(n, true);
    assert.ok(running !== "resume", `${n} never resumes a running pty`);
    assert.ok(held !== "pause", `${n} never re-pauses a paused pty`);
  }
});

// --- docker targets on another machine (spec 26) ----------------------------

test("docker targets parse with and without an endpoint", async () => {
  const { parseDockerTerminalTarget } = await import("./terminal-server");
  assert.deepEqual(parseDockerTerminalTarget("docker://nexux-app/opt/nexus"), {
    endpointId: null,
    container: "nexux-app",
    path: "/opt/nexus",
  });
  assert.deepEqual(parseDockerTerminalTarget("docker://cmfoo123@nexux-app"), {
    endpointId: "cmfoo123",
    container: "nexux-app",
    path: "",
  });
  // A host never travels in the URL — only an id the server looks up.
  for (const bad of [
    "docker://ssh://omarchy@nexux-app",
    "docker://-H@nexux-app",
    "docker://a.b@nexux-app",
    "docker://id@-app",
    "docker://id@app/it's",
  ]) {
    assert.equal(parseDockerTerminalTarget(bad), null, bad);
  }
});

test("a container on a known endpoint is exec'd through that daemon", posixShell, async () => {
  const s = await connect({ cwd: "docker://ep1@nexux-app/opt/nexus", cols: "80", rows: "24" });
  // The connect banner names the daemon, and docker's own failure to reach it
  // proves -H went into argv (a local exec would say "No such container").
  await s.waitFor(/nexux-app on ssh:\/\/nobody@nexux-test\.invalid/);
  // Not /connect/ — the banner itself says "connecting".
  await s.waitFor(/Could not resolve hostname|error during connect|docker: (command )?not found|ENOENT/i);
  s.ws.close();
});

test("an unknown endpoint closes the session instead of falling back to this machine", posixShell, async () => {
  const s = await connect({ cwd: "docker://gone@nexux-app", cols: "80", rows: "24" });
  await s.waitFor(/no Docker endpoint gone/);
  assert.ok(!/No such container/i.test(s.output()), s.output());
  s.ws.close();
});
