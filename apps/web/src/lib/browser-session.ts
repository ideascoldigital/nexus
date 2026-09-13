// The interactive browser session on a sandbox (spec 23).
//
// Two services on one instance cannot be tested through tunnels: each process
// gets its own random public hostname, so a front end's API_URL is wrong from
// the viewer's browser whatever it says. Inside the sandbox both are plain
// localhost ports that already agree — so the browser runs there and the
// dashboard reaches it from here.
//
// The transport is an SSH port-forward owned by THIS process, not a tunnel.
// The forward is a local child (`ssh -L`), so it cannot go through execRemote
// like the session scripts do: it lives here, keyed by sandbox, and is reaped
// on restart the way recoverOrphanSandboxes settles interrupted provisions.
//
// Nothing the session exposes may reach a public interface. That is enforced
// in the rendered scripts (@nexux/sandbox/template-browser) and re-asserted
// here in the forward's own flags: an open VNC or CDP port hands whoever finds
// it a browser with unrestricted access to this instance's localhost — the
// checkouts, the .env files and the git credentials on it.

import { randomBytes } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import net from "node:net";

import { getConfig } from "@nexux/config";
import { prisma, type BrowserSession } from "@nexux/db";
import {
  BROWSER_LOG,
  execRemote,
  parseBrowserStart,
  renderBrowserStartScript,
  renderBrowserStopScript,
  sandboxPrivateKeyPath,
  VNC_TOKEN_LENGTH,
} from "@nexux/sandbox";

import { sandboxReachable, sandboxTarget } from "@/lib/agent-core";

/** A session as the UI sees it: the row plus where this host serves it. */
export type BrowserSessionView = Omit<BrowserSession, "token"> & {
  /** Loopback URL on THIS machine, once the forward is up. Null when down. */
  localUrl: string | null;
  /** The VNC password, needed by the noVNC client in the browser. */
  token: string | null;
};

/** Live forwards, keyed by sandbox id. Lost on restart — see reapForwards. */
type Forward = { child: ChildProcess; localPort: number; sandboxId: string };
const forwards = new Map<string, Forward>();

/**
 * A VNC password. The protocol truncates to 8 bytes, so generating more would
 * be security theatre — the extra characters are silently discarded and the
 * displayed secret would not be the one that authenticates.
 */
export function generateToken(): string {
  // Alphanumerics minus every pair that misreads when retyped from the screen:
  // l/I/1, O/o/0, and B/8. A VNC password is read off one pane and typed into
  // another, so an ambiguous glyph costs a failed connection with no diagnostic.
  const alphabet = "abcdefghijkmnpqrstuvwxyzACDEFGHJKLMNPQRSTUVWXYZ234567";
  const bytes = randomBytes(VNC_TOKEN_LENGTH);
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
}

/** An unused loopback port for the forward to land on. */
export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on("error", reject);
    // Bind loopback explicitly: a forward listening on 0.0.0.0 would publish
    // the sandbox's browser to this machine's whole network.
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (typeof addr === "string" || !addr) {
        srv.close(() => reject(new Error("Could not pick a local port")));
        return;
      }
      const { port } = addr;
      srv.close(() => resolve(port));
    });
  });
}

async function loadSandbox(projectId: string, sandboxId: string) {
  const sandbox = await prisma.sandbox.findFirst({
    where: { id: sandboxId, projectId },
  });
  if (!sandbox) throw new Error("Sandbox not found");
  return sandbox;
}

/**
 * The ssh arguments for the forward. Pure, so the flags can be asserted
 * without a reachable host — the interesting cases are the ones that never
 * connect.
 */
export function forwardArgs(opts: {
  localPort: number;
  remotePort: number;
  host: string;
  user: string;
  privateKeyPath: string;
}): string[] {
  return [
    "-i",
    opts.privateKeyPath,
    "-o",
    // Offer only the sandbox key: agent-loaded keys exhaust the server's
    // MaxAuthTries before it is ever tried.
    "IdentitiesOnly=yes",
    "-o",
    "StrictHostKeyChecking=accept-new",
    "-o",
    "ConnectTimeout=15",
    // A forward whose instance vanishes otherwise hangs until TCP gives up,
    // and the tab shows a dead iframe rather than an error.
    "-o",
    "ServerAliveInterval=15",
    "-o",
    "ServerAliveCountMax=3",
    "-o",
    "ExitOnForwardFailure=yes",
    "-N", // no remote command: this connection exists only to forward
    "-L",
    // 127.0.0.1 on both ends. The bind address is not a default worth
    // trusting — ssh honours GatewayPorts, and a config that sets it would
    // otherwise publish the session to the local network.
    `127.0.0.1:${opts.localPort}:127.0.0.1:${opts.remotePort}`,
    `${opts.user}@${opts.host}`,
  ];
}

/** Wait until something answers on the forwarded port, or give up. */
async function waitForPort(port: number, attempts = 30): Promise<boolean> {
  for (let i = 0; i < attempts; i++) {
    const ok = await new Promise<boolean>((resolve) => {
      const sock = net
        .connect({ port, host: "127.0.0.1" })
        .on("connect", () => {
          sock.destroy();
          resolve(true);
        })
        .on("error", () => resolve(false));
      sock.setTimeout(1000, () => {
        sock.destroy();
        resolve(false);
      });
    });
    if (ok) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

/** Drop the forward for a sandbox, if this process holds one. */
export function stopForward(sandboxId: string): void {
  const fwd = forwards.get(sandboxId);
  if (!fwd) return;
  forwards.delete(sandboxId);
  try {
    fwd.child.kill();
  } catch {
    // Already gone — the session is down either way.
  }
}

/**
 * Settle sessions this process can no longer be serving.
 *
 * A forward is a child of the server process, so a restart kills every one of
 * them while the rows still say `running`. Same reasoning as
 * recoverOrphanSandboxes: a status nothing is backing is worse than an error,
 * because the UI offers a working iframe that can never connect.
 */
export async function reapForwards(): Promise<void> {
  const stale = await prisma.browserSession.findMany({
    where: { status: { in: ["running", "starting"] } },
    select: { id: true, sandboxId: true },
  });
  for (const row of stale) {
    if (forwards.has(row.sandboxId)) continue; // this process is serving it
    await prisma.browserSession
      .update({
        where: { id: row.id },
        data: { status: "stopped", error: null },
      })
      .catch(() => undefined);
  }
}

/** The row for a sandbox, with what this host knows about serving it. */
export async function getBrowserSession(
  projectId: string,
  sandboxId: string,
): Promise<BrowserSessionView | null> {
  await loadSandbox(projectId, sandboxId);
  const row = await prisma.browserSession.findUnique({ where: { sandboxId } });
  if (!row) return null;
  return toView(row);
}

function toView(row: BrowserSession): BrowserSessionView {
  const fwd = forwards.get(row.sandboxId);
  const live = row.status === "running" && Boolean(fwd);
  return {
    ...row,
    // The password only travels once the session is actually up: a stored
    // secret handed out for a stopped session is a secret leaked for nothing.
    token: live ? row.token : null,
    localUrl: live ? `http://127.0.0.1:${fwd!.localPort}` : null,
  };
}

/**
 * Start (or restart) the session: run the script on the instance, then open
 * the forward. Replaces whatever was there — one browser per sandbox.
 */
export async function startBrowserSession(
  projectId: string,
  sandboxId: string,
  opts: { width?: number; height?: number } = {},
): Promise<BrowserSessionView> {
  const sandbox = await loadSandbox(projectId, sandboxId);
  if (!sandboxReachable(sandbox)) {
    throw new Error("The sandbox is not running");
  }

  // A restart must not leave the previous forward holding a local port.
  stopForward(sandboxId);

  const token = generateToken();
  const existing = await prisma.browserSession.findUnique({
    where: { sandboxId },
  });
  const width = opts.width ?? existing?.width ?? undefined;
  const height = opts.height ?? existing?.height ?? undefined;

  const row = await prisma.browserSession.upsert({
    where: { sandboxId },
    create: {
      sandboxId,
      token,
      status: "starting",
      ...(width ? { width } : {}),
      ...(height ? { height } : {}),
    },
    update: {
      token,
      status: "starting",
      error: null,
      startedAt: null,
      ...(width ? { width } : {}),
      ...(height ? { height } : {}),
    },
  });

  const script = renderBrowserStartScript({
    token,
    display: row.display,
    vncPort: row.vncPort,
    wsPort: row.wsPort,
    cdpPort: row.cdpPort,
    width: row.width,
    height: row.height,
  });

  const fail = async (message: string) => {
    stopForward(sandboxId);
    const updated = await prisma.browserSession.update({
      where: { id: row.id },
      data: { status: "error", error: message },
    });
    return toView(updated);
  };

  // Keep the transport failure itself: swallowing it leaves the caller unable
  // to tell "the browser died" from "the box is gone".
  let res: Awaited<ReturnType<typeof execRemote>> | null = null;
  try {
    res = await execRemote(script, {
      ...sandboxTarget(sandbox, "/opt/nexus"),
      timeoutMs: 180_000,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return fail(`Could not reach the sandbox: ${message}`);
  }

  const out = (res.stdout ?? "").trim();
  const started = parseBrowserStart(out);
  if (!started) {
    if (out.includes("XVFB_FAILED")) {
      return fail("The virtual display did not start. Check the session log.");
    }
    if (out.includes("WS_FAILED")) {
      return fail(
        "The browser started but its WebSocket bridge did not answer. Check the session log.",
      );
    }
    return fail("The session script ended without reporting the browser up.");
  }

  // Local sandboxes have no sshd, so there is nothing to forward through —
  // docker publishes the port instead and the container is already reachable
  // from this machine.
  if (sandbox.provider === "local") {
    const updated = await prisma.browserSession.update({
      where: { id: row.id },
      data: { status: "running", error: null, startedAt: new Date() },
    });
    return toView(updated);
  }

  if (!sandbox.publicIp) return fail("The sandbox has no address to reach");

  const localPort = await freePort();
  const target = sandboxTarget(sandbox, "/opt/nexus");
  const child = spawn(
    "ssh",
    forwardArgs({
      localPort,
      remotePort: started.wsPort,
      host: sandbox.publicIp,
      user: target.user ?? "nexus",
      privateKeyPath: sandboxPrivateKeyPath(getConfig().dataDir),
    }),
    { stdio: "ignore", detached: false },
  );
  forwards.set(sandboxId, { child, localPort, sandboxId });
  child.on("exit", () => {
    // Only clear if this is still the current forward: a restart replaces the
    // entry, and the old child's exit must not unregister the new one.
    if (forwards.get(sandboxId)?.child === child) forwards.delete(sandboxId);
  });

  if (!(await waitForPort(localPort))) {
    return fail("The browser is up on the sandbox, but the SSH forward did not open.");
  }

  const updated = await prisma.browserSession.update({
    where: { id: row.id },
    data: { status: "running", error: null, startedAt: new Date() },
  });
  return toView(updated);
}

/** Stop the session on the instance and drop the forward. */
export async function stopBrowserSession(
  projectId: string,
  sandboxId: string,
): Promise<void> {
  const sandbox = await loadSandbox(projectId, sandboxId);
  stopForward(sandboxId);

  if (sandboxReachable(sandbox)) {
    await execRemote(renderBrowserStopScript(), {
      ...sandboxTarget(sandbox, "/opt/nexus"),
      timeoutMs: 30_000,
    }).catch(() => undefined);
  }

  await prisma.browserSession
    .updateMany({
      where: { sandboxId },
      data: { status: "stopped", error: null },
    })
    .catch(() => undefined);
}

/** Tail the session log from the instance. */
export async function readBrowserSessionLog(
  projectId: string,
  sandboxId: string,
): Promise<string> {
  const sandbox = await loadSandbox(projectId, sandboxId);
  if (!sandboxReachable(sandbox)) return "";
  const res = await execRemote(`tail -n 200 ${BROWSER_LOG} 2>/dev/null || true`, {
    ...sandboxTarget(sandbox, "/opt/nexus"),
    timeoutMs: 20_000,
  }).catch(() => null);
  return (res?.stdout ?? "").trim();
}
