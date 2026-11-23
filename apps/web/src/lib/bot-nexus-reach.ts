// How a bot on another machine's daemon reaches Nexus (D-88).
//
// The vault's MCP server runs inside the computer and relays to Nexus over
// HTTP, and the system prompt hands the bot Nexus's own URL. Both were
// `host.docker.internal`, which Docker maps to the *daemon host's* gateway —
// this machine when the daemon is local, and the other machine when it is
// not, where nothing of ours listens. A remote bot got "fetch failed" from
// every vault call.
//
// The two machines are not symmetrically reachable: this one opens SSH to the
// endpoint, and the endpoint cannot open anything back (on a home network the
// two sit on different subnets and the router drops the return direction).
// So the only channel is the SSH connection we already have, used backwards:
//
//   bot container ──→ <bridge gateway>:port
//                       │   socat, in the daemon host's network namespace
//                       ↓
//                     127.0.0.1:port on the daemon's host
//                       │   ssh -R, opened from here
//                       ↓
//                     127.0.0.1:<nexus port> — Nexus
//
// The relay container is there because sshd's `GatewayPorts` defaults to
// `no`: a reverse forward binds the remote loopback and nothing else, which a
// bridged container cannot reach. Asking every user to edit sshd is worse
// than running a 5 MB socat container, so the container republishes that
// loopback port on the bridge. Both ends use the same port number — they bind
// different addresses on the same host, so they never collide.
//
// The last hop is the daemon host's own firewall, which we cannot fix from
// here: `ufw` and friends drop bridge→host traffic by default. So the reach
// is *probed* before it is handed out, and a failure names the rule to add
// rather than leaving the bot to report "fetch failed".

import { spawn, type ChildProcess } from "node:child_process";

import { dockerHostKind, sshUrlParts } from "@nexux/sandbox";

import { hostAppUrl } from "@/lib/bot-view";

/** The image that republishes the tunnel on the bridge. Small and stable. */
const RELAY_IMAGE = "alpine/socat:latest";
const RELAY_LABEL = "nexux-nexus-relay=1";

/**
 * The bridge-side port, fixed on purpose. sshd allocates the tunnel's own
 * port afresh every time, and the firewall rule the daemon host needs names a
 * port — so a dynamic one would mean a rule that works once and never again.
 * The tunnel stays dynamic (no collisions on the remote loopback); only the
 * face the containers see is pinned.
 */
const RELAY_PORT = 47600;

type Reach = { child: ChildProcess; port: number; url: string; container: string };

// On globalThis so HMR and a re-import do not lose the children.
const g = globalThis as unknown as { nexuxNexusReach?: Map<string, Reach> };
const reaches = (g.nexuxNexusReach ??= new Map<string, Reach>());

function alive(r: Reach | undefined): r is Reach {
  return Boolean(r && !r.child.killed && r.child.exitCode === null);
}

/** `ssh://user@host:22` → a container-safe name for its relay. */
function relayName(dockerHost: string): string {
  const slug = dockerHost.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  return `nexux-nexus-relay-${slug || "endpoint"}`;
}

function docker(dockerHost: string, args: string[], timeoutMs = 60_000) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    const child = spawn("docker", ["-H", dockerHost, ...args], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += String(d)));
    child.stderr.on("data", (d) => (stderr += String(d)));
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout: stdout.trim(), stderr: stderr.trim() });
    });
    child.on("error", () => {
      clearTimeout(timer);
      resolve({ code: -1, stdout: "", stderr: "docker could not be started" });
    });
  });
}

/** The address a container reaches its own daemon host on, e.g. 172.17.0.1. */
async function bridgeGateway(dockerHost: string): Promise<string | null> {
  const res = await docker(dockerHost, [
    "network",
    "inspect",
    "bridge",
    "--format",
    "{{(index .IPAM.Config 0).Gateway}}",
  ]);
  const ip = res.stdout.split("\n")[0]?.trim();
  return res.code === 0 && /^\d+\.\d+\.\d+\.\d+$/.test(ip ?? "") ? ip! : null;
}

/**
 * `ssh -N -R 0:127.0.0.1:<nexusPort>` — the remote end chooses the port and
 * says so on stderr, which avoids guessing one that is already taken there.
 */
function openTunnel(dockerHost: string, nexusPort: number): Promise<{ child: ChildProcess; port: number }> {
  const parts = sshUrlParts(dockerHost);
  if (!parts) throw new Error(`Not an SSH Docker endpoint: ${dockerHost}`);
  const args = [
    "-o",
    "BatchMode=yes",
    "-o",
    "ConnectTimeout=15",
    "-o",
    "ServerAliveInterval=15",
    "-o",
    "ServerAliveCountMax=3",
    "-o",
    "ExitOnForwardFailure=yes",
    ...(parts.port ? ["-p", String(parts.port)] : []),
    "-N",
    "-R",
    // Port 0: sshd allocates. Loopback is all GatewayPorts=no would give us
    // anyway, and the relay is what carries it the rest of the way.
    `0:127.0.0.1:${nexusPort}`,
    "--",
    parts.user ? `${parts.user}@${parts.hostname}` : parts.hostname,
  ];
  return new Promise((resolve, reject) => {
    const child = spawn("ssh", args, { stdio: ["ignore", "ignore", "pipe"] });
    let said = "";
    const done = (err: Error | null, port?: number) => {
      clearTimeout(timer);
      child.stderr?.removeAllListeners("data");
      if (err) {
        child.kill("SIGKILL");
        reject(err);
      } else {
        resolve({ child, port: port! });
      }
    };
    const timer = setTimeout(
      () => done(new Error(`the endpoint did not grant a return port${said ? `: ${said.trim()}` : ""}`)),
      20_000,
    );
    child.stderr?.on("data", (d) => {
      said += String(d);
      const m = /Allocated port (\d+) for remote forward/i.exec(said);
      if (m) done(null, Number(m[1]));
    });
    child.on("exit", () => done(new Error(`the return tunnel closed${said ? `: ${said.trim()}` : ""}`)));
    child.on("error", (e) => done(e));
  });
}

/** socat in the daemon host's network namespace: bridge:RELAY_PORT → loopback:tunnelPort. */
async function startRelay(dockerHost: string, gateway: string, tunnelPort: number): Promise<string> {
  const name = relayName(dockerHost);
  await docker(dockerHost, ["rm", "-f", name], 30_000);
  const run = await docker(
    dockerHost,
    [
      "run",
      "-d",
      "--name",
      name,
      "--network",
      "host",
      "--label",
      RELAY_LABEL,
      RELAY_IMAGE,
      `TCP-LISTEN:${RELAY_PORT},fork,reuseaddr,bind=${gateway}`,
      `TCP:127.0.0.1:${tunnelPort}`,
    ],
    // The image may not be on that daemon yet.
    180_000,
  );
  if (run.code !== 0) throw new Error(`could not start the relay: ${run.stderr || run.stdout}`);
  return name;
}

/**
 * Does a container on that daemon actually reach Nexus? Docker gives no error
 * for a blocked route — the connection just hangs — so this asks a throwaway
 * container and lets the caller say something useful when the answer is no.
 */
async function relayReaches(dockerHost: string): Promise<boolean> {
  const res = await docker(
    dockerHost,
    [
      "run",
      "--rm",
      "--add-host=host.docker.internal:host-gateway",
      "alpine:latest",
      "nc",
      "-z",
      "-w",
      "5",
      "host.docker.internal",
      String(RELAY_PORT),
    ],
    90_000,
  );
  return res.code === 0;
}

/** What a firewall on the daemon host looks like from here, and how to fix it. */
export function blockedReachHint(gateway: string): string {
  return (
    `the computer cannot reach Nexus: the daemon host is refusing traffic from its own Docker bridge. ` +
    `On that machine, allow it once with: sudo ufw allow in on docker0 to ${gateway} port ${RELAY_PORT} proto tcp`
  );
}

/**
 * Nexus's URL as the bot's computer can reach it.
 *
 * A local daemon shares this machine's loopback through `host.docker.internal`
 * and needs nothing. A remote one gets the tunnel and relay above, reused
 * while they live.
 */
export async function botNexusUrl(dockerHost: string | null): Promise<string> {
  if (dockerHostKind(dockerHost) !== "remote" || !dockerHost) return hostAppUrl();

  const live = reaches.get(dockerHost);
  if (alive(live)) return live.url;

  const nexusPort = Number(process.env.PORT || "3000");
  const gateway = await bridgeGateway(dockerHost);
  if (!gateway) throw new Error("could not read the daemon's bridge gateway");

  const { child, port } = await openTunnel(dockerHost, nexusPort);
  let container: string;
  try {
    container = await startRelay(dockerHost, gateway, port);
  } catch (err) {
    child.kill("SIGKILL");
    throw err;
  }
  if (!(await relayReaches(dockerHost))) {
    child.kill("SIGKILL");
    await docker(dockerHost, ["rm", "-f", container], 30_000);
    throw new Error(blockedReachHint(gateway));
  }

  const url = `http://host.docker.internal:${RELAY_PORT}`;
  const reach: Reach = { child, port, url, container };
  reaches.set(dockerHost, reach);
  child.on("exit", () => {
    // A replacement must not be unregistered by the old child's exit.
    if (reaches.get(dockerHost) === reach) reaches.delete(dockerHost);
    void docker(dockerHost, ["rm", "-f", container], 30_000);
  });
  return url;
}

/** Nothing on that endpoint needs Nexus any more. */
export async function closeNexusReach(dockerHost: string): Promise<void> {
  const reach = reaches.get(dockerHost);
  if (!reach) return;
  reaches.delete(dockerHost);
  try {
    reach.child.kill("SIGKILL");
  } catch {
    // Already gone.
  }
  await docker(dockerHost, ["rm", "-f", reach.container], 30_000);
}
