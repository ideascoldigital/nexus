/**
 * Can this Docker endpoint host a sandbox? (spec 28 phase 5)
 *
 * The endpoint probe says the daemon answers and is not rootless. A sandbox
 * needs more, all of it checkable in seconds with throwaway busybox
 * containers: privileged runs (it is Docker-in-Docker), DNS both on the
 * default bridge and on a compose-style network (a machine can have the first
 * and not the second — `devbox` did), the internet, disk for images, and —
 * for a daemon on this machine — whether a bind mount from here actually
 * arrives.
 *
 * Everything created is removed, including the temporary network.
 */

import { randomBytes } from "crypto";
import fs from "fs";
import path from "path";

import { getConfig } from "@nexux/config";
import { dockerHostArgs, dockerHostKind, probeDockerEndpoint } from "@nexux/sandbox";

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

const MOUNT_LABEL = "bind mounts see this machine's files";

/**
 * Does `-v <path on this machine>` reach a container on this daemon?
 *
 * Worth asking only of a daemon that is on this machine, and not obvious even
 * then: one behind its own socket can sit inside a VM that shares all of the
 * filesystem (OrbStack), part of it (Docker Desktop's configured list) or
 * none of it. Docker does not fail a mount it cannot honour — it creates an
 * empty directory on its own side — so the only way to know is to write a
 * value here and have a container read it back.
 *
 * What hangs on the answer: a sandbox mounts a repo that has no clone URL,
 * and a bot mounts its workspace and its browser profile. Where those live is
 * the difference between work you can open in Finder and work that quietly
 * stays on the daemon's side.
 */
async function checkBindMount(
  run: DockerRunner,
  H: string[],
  dataDir: string,
): Promise<CheckLine> {
  const marker = randomBytes(8).toString("hex");
  const dir = path.join(dataDir, `mount-probe-${marker}`);
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "marker"), marker);
    const res = await run(
      [...H, "run", "--rm", "-v", `${dir}:/probe:ro`, IMAGE, "cat", "/probe/marker"],
      { timeoutMs: 60_000 },
    );
    if (res.code === 0 && res.stdout.trim() === marker) return { label: MOUNT_LABEL, ok: true };
    const stderr = res.stderr.trim().slice(-200);
    return {
      label: MOUNT_LABEL,
      ok: false,
      detail:
        "a container here could not read back a file this machine had just written, so this daemon does not share this filesystem — a mounted repo, a bot's workspace and its sign-ins would all live on the daemon's side instead" +
        (stderr ? `\n${stderr}` : ""),
    };
  } catch (err) {
    // Could not even stage the probe: that is this machine's problem, not the
    // endpoint's, so it is unknown rather than a failure.
    return {
      label: MOUNT_LABEL,
      ok: null,
      detail: err instanceof Error ? err.message : String(err),
    };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

export async function checkEndpointForSandboxes(
  host: string,
  deps: {
    run?: DockerRunner;
    now?: () => Date;
    probe?: typeof probeDockerEndpoint;
    /** Where the bind-mount probe stages its marker. Injected by the tests. */
    dataDir?: string;
  } = {},
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

  lines.push(
    dockerHostKind(host) === "remote"
      ? {
          label: MOUNT_LABEL,
          ok: null,
          detail:
            "a daemon on another machine mounts that machine's paths, not this one's — a sandbox there clones its repo instead of mounting it",
        }
      : await checkBindMount(run, H, deps.dataDir ?? getConfig().dataDir),
  );

  const hardFail = lines.some((l) => l.ok === false && /privileged|default bridge/.test(l.label));
  const status: CredentialCheck["status"] = hardFail ? "fail" : lines.some((l) => l.ok === false) ? "warn" : "ok";
  return { status, identity: identity || null, expiresAt: null, scopes: null, checks: lines, checkedAt };
}
