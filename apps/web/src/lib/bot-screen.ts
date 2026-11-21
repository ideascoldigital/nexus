// A bot's screen, when its computer is on another machine's daemon (D-85).
//
// noVNC is published on the daemon's loopback, so for a remote endpoint the
// dashboard cannot reach it directly — the same problem a sandbox's browser
// session has, solved the same way: `ssh -L` through the endpoint's own SSH,
// authenticated with the user's keys for that host.
//
// What the session row stores is always *the port on this machine*: the
// published one when the daemon is local, the forward's local one when it is
// not. Everything downstream (botVncUrl, the dashboard) stays unchanged.

import { spawn, type ChildProcess } from "node:child_process";

import { dockerHostKind } from "@nexux/sandbox";

import { endpointForwardArgs, freePort, waitForPort } from "@/lib/browser-session";

type Forward = { child: ChildProcess; localPort: number };

// On globalThis so HMR and a re-import do not lose the children.
const g = globalThis as unknown as { nexuxBotForwards?: Map<string, Forward> };
const forwards = (g.nexuxBotForwards ??= new Map<string, Forward>());

/**
 * The port on this machine that shows `sessionId`'s screen.
 *
 * A local daemon publishes on this loopback already, so its port is returned
 * as it is. A remote one gets an SSH forward, reused while it lives.
 */
export async function botScreenLocalPort(opts: {
  sessionId: string;
  dockerHost: string | null;
  remotePort: number;
}): Promise<number | null> {
  if (dockerHostKind(opts.dockerHost) !== "remote" || !opts.dockerHost) {
    return opts.remotePort;
  }
  const live = forwards.get(opts.sessionId);
  if (live && !live.child.killed && live.child.exitCode === null) return live.localPort;

  const localPort = await freePort();
  const child = spawn(
    "ssh",
    endpointForwardArgs({ localPort, remotePort: opts.remotePort, dockerHost: opts.dockerHost }),
    { stdio: "ignore", detached: false },
  );
  forwards.set(opts.sessionId, { child, localPort });
  child.on("exit", () => {
    // A replacement must not be unregistered by the old child's exit.
    if (forwards.get(opts.sessionId)?.child === child) forwards.delete(opts.sessionId);
  });
  if (!(await waitForPort(localPort))) {
    closeBotScreenForward(opts.sessionId);
    return null;
  }
  return localPort;
}

/** The computer is gone (or being replaced): drop its forward. */
export function closeBotScreenForward(sessionId: string): void {
  const f = forwards.get(sessionId);
  if (!f) return;
  forwards.delete(sessionId);
  try {
    f.child.kill("SIGKILL");
  } catch {
    // Already gone.
  }
}
