/**
 * Can this Docker endpoint host a sandbox? (spec 28 phase 5)
 *
 * The endpoint probe says the daemon answers and is not rootless. A sandbox
 * needs more, all of it checkable in seconds with throwaway busybox
 * containers: privileged runs (it is Docker-in-Docker), DNS both on the
 * default bridge and on a compose-style network (a machine can have the first
 * and not the second — `devbox` did), the internet, and disk for images.
 *
 * Everything created is removed, including the temporary network.
 */

import { randomBytes } from "crypto";

import { dockerHostArgs, probeDockerEndpoint } from "@nexux/sandbox";

import { runDocker, type DockerRunner } from "@/lib/host-endpoint";

import type { CheckLine, CredentialCheck } from "./types";

const IMAGE = "busybox";
const MIN_FREE_GB = 10;

/** busybox nslookup prints `Name:` only when an answer came back. */
export function dnsAnswered(output: string): boolean {
  return /^Name:\s+\S+/m.test(output) && !/no servers could be reached/i.test(output);
}

/**
 * `df -k` → free GB on the mount, or null. Anchored on the `Use%` column
 * rather than a position: busybox wraps a long filesystem name (an LVM
 * `/dev/mapper/…`) onto its own line, shifting every column after it.
 */
export function freeGbFromDf(output: string): number | null {
  const tokens = output.trim().split("\n").slice(1).join(" ").trim().split(/\s+/);
  const pct = tokens.findIndex((t) => /^\d+%$/.test(t));
  const avail = pct > 0 ? Number(tokens[pct - 1]) : NaN;
  return Number.isFinite(avail) ? Math.round((avail / 1024 / 1024) * 10) / 10 : null;
}

export async function checkEndpointForSandboxes(
  host: string,
  deps: { run?: DockerRunner; now?: () => Date; probe?: typeof probeDockerEndpoint } = {},
): Promise<CredentialCheck> {
  const run = deps.run ?? runDocker;
  const checkedAt = (deps.now?.() ?? new Date()).toISOString();
  const H = dockerHostArgs({ host });
  const lines: CheckLine[] = [];

  const probed = await (deps.probe ?? probeDockerEndpoint)(host);
  if (!probed.ok) {
    return {
      status: "fail",
      identity: null,
      expiresAt: null,
      scopes: null,
      checks: [{ label: "daemon answers, not rootless", ok: false, detail: probed.error }],
      checkedAt,
    };
  }
  lines.push({ label: "daemon answers, not rootless", ok: true });
  const identity = [probed.arch, probed.serverVersion ? `Docker ${probed.serverVersion}` : null]
    .filter(Boolean)
    .join(" · ");

  const privileged = await run([...H, "run", "--rm", "--privileged", IMAGE, "true"], { timeoutMs: 180_000 });
  lines.push(
    privileged.code === 0
      ? { label: "runs privileged containers", ok: true }
      : { label: "runs privileged containers", ok: false, detail: `a sandbox is Docker-in-Docker and needs --privileged: ${privileged.stderr.trim().slice(-200)}` },
  );

  const bridgeDns = await run([...H, "run", "--rm", IMAGE, "nslookup", "github.com"], { timeoutMs: 60_000 });
  const bridgeOk = dnsAnswered(bridgeDns.stdout + bridgeDns.stderr);
  lines.push(
    bridgeOk
      ? { label: "DNS on the default bridge", ok: true }
      : { label: "DNS on the default bridge", ok: false, detail: "the sandbox container itself cannot resolve names — check `dns` in /etc/docker/daemon.json" },
  );

  // A compose-style network, as a Nexus host's stack gets. The sandbox
  // container itself sits on the default bridge, and its own services resolve
  // through it, so this failing does not stop a sandbox — it stops anything
  // run with compose on this daemon. Docker isolates these networks from
  // docker0, so a resolver bound only there answers the default bridge alone.
  const network = `nexux-check-${randomBytes(4).toString("hex")}`;
  let netOk = false;
  const created = await run([...H, "network", "create", network], { timeoutMs: 30_000 });
  if (created.code === 0) {
    try {
      const netDns = await run([...H, "run", "--rm", "--network", network, IMAGE, "nslookup", "github.com"], { timeoutMs: 60_000 });
      netOk = dnsAnswered(netDns.stdout + netDns.stderr);
    } finally {
      await run([...H, "network", "rm", network], { timeoutMs: 30_000 });
    }
  }
  lines.push(
    netOk
      ? { label: "DNS on a compose-style network", ok: true }
      : {
          label: "DNS on a compose-style network",
          ok: false,
          detail: bridgeOk
            ? "names resolve on the default bridge but not on user-defined networks — sandboxes still work, but a Nexus host (or anything run with compose) here cannot reach the internet by name. Typically `dns` in /etc/docker/daemon.json points at a resolver only docker0 can reach (like 172.17.0.1); point it at your router or a public resolver and restart Docker."
            : "no DNS here either — check `dns` in /etc/docker/daemon.json",
        },
  );

  const net = await run([...H, "run", "--rm", IMAGE, "nc", "-z", "-w", "5", "github.com", "443"], { timeoutMs: 60_000 });
  lines.push(
    net.code === 0
      ? { label: "reaches the internet", ok: true }
      : { label: "reaches the internet", ok: bridgeOk ? false : null, detail: bridgeOk ? "github.com:443 is unreachable from a container" : "untestable without DNS" },
  );

  let freeGb: number | null = null;
  const root = await run([...H, "info", "--format", "{{.DockerRootDir}}"], { timeoutMs: 30_000 });
  const rootDir = root.stdout.trim();
  if (root.code === 0 && rootDir.startsWith("/")) {
    // Read-only: the check looks at the disk, never touches it.
    const df = await run([...H, "run", "--rm", "-v", `${rootDir}:/r:ro`, IMAGE, "df", "-k", "/r"], { timeoutMs: 60_000 });
    if (df.code === 0) freeGb = freeGbFromDf(df.stdout);
  }
  lines.push(
    freeGb === null
      ? { label: "disk space for Docker", ok: null, detail: "could not read it" }
      : { label: "disk space for Docker", ok: freeGb >= MIN_FREE_GB, detail: `${freeGb} GB free${freeGb < MIN_FREE_GB ? ` — images and a sandbox's own Docker need more than ${MIN_FREE_GB} GB` : ""}` },
  );

  const hardFail = lines.some((l) => l.ok === false && /privileged|default bridge/.test(l.label));
  const status: CredentialCheck["status"] = hardFail ? "fail" : lines.some((l) => l.ok === false) ? "warn" : "ok";
  return { status, identity: identity || null, expiresAt: null, scopes: null, checks: lines, checkedAt };
}
