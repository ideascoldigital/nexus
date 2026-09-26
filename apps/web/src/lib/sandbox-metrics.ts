// What each local sandbox is consuming: CPU, memory and the disk its writes
// land on.
//
// One `docker stats --no-stream` call covers every container at once, which is
// the only reason this is cheap enough to poll: per-container stats would be a
// round trip each, and a host with a dozen sandboxes would spend more time
// measuring than running. Disk is the exception — it lives inside the
// container's filesystem, so it costs one `exec` per sandbox and is therefore
// only collected for the detail page, never for the bar.
//
// Sandboxes on another machine's Docker (spec 26) are measured the same way,
// one `docker -H` per daemon, in parallel — a slow endpoint delays only its own
// rows, and one that does not answer is reported as such rather than as "no
// sandboxes".
//
// Cloud sandboxes are out of scope here. They are reached over ssh, their
// metrics cost a network round trip each, and a box that is merely slow would
// hold up the whole response; that belongs behind its own explicitly-requested
// call rather than a poll.

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { dockerHostArgs } from "@nexux/sandbox";

import { parseDf } from "./system-metrics";

const execFileAsync = promisify(execFile);

type Runner = (
  bin: string,
  args: string[],
  opts: { timeout: number; maxBuffer: number },
) => Promise<{ stdout: string }>;

const defaultRun: Runner = (bin, args, opts) => execFileAsync(bin, args, opts);

export type SandboxMetric = {
  /** The container name, which is the sandbox name for a local sandbox. */
  name: string;
  /** Which daemon it runs on: null = this machine, else a DockerEndpoint id. */
  endpointId: string | null;
  cpuPercent: number | null;
  memPercent: number | null;
  memUsedBytes: number | null;
  memLimitBytes: number | null;
  /** Only present when asked for: it costs an exec per container. */
  diskPercent?: number | null;
  diskUsedBytes?: number | null;
  diskTotalBytes?: number | null;
};

/** `docker stats` prints human sizes; this turns them back into bytes. */
export function parseSize(raw: string): number | null {
  const match = raw.trim().match(/^([\d.]+)\s*([KMGT]?i?B)$/i);
  if (!match) return null;
  const value = Number(match[1]);
  if (!Number.isFinite(value)) return null;
  const unit = match[2].toLowerCase();
  const scale: Record<string, number> = {
    b: 1,
    kb: 1000,
    kib: 1024,
    mb: 1000 ** 2,
    mib: 1024 ** 2,
    gb: 1000 ** 3,
    gib: 1024 ** 3,
    tb: 1000 ** 4,
    tib: 1024 ** 4,
  };
  const factor = scale[unit];
  return factor ? Math.round(value * factor) : null;
}

function parsePercent(raw: string): number | null {
  const value = Number(raw.replace("%", "").trim());
  return Number.isFinite(value) ? Math.round(value * 10) / 10 : null;
}

/**
 * One line per container, as emitted by the `--format` below.
 *
 * The separator is a pipe rather than whitespace because `MemUsage` contains
 * spaces ("419.8MiB / 10.44GiB") and would otherwise split into three fields.
 */
export function parseDockerStats(stdout: string): SandboxMetric[] {
  const rows: SandboxMetric[] = [];
  for (const line of stdout.trim().split("\n")) {
    if (!line.trim()) continue;
    const [name, cpu, mem, memPct] = line.split("|");
    if (!name) continue;
    const [used, limit] = (mem ?? "").split("/");
    rows.push({
      name: name.trim(),
      endpointId: null,
      cpuPercent: parsePercent(cpu ?? ""),
      memPercent: parsePercent(memPct ?? ""),
      memUsedBytes: used ? parseSize(used) : null,
      memLimitBytes: limit ? parseSize(limit) : null,
    });
  }
  return rows;
}

const EXEC = { timeout: 6000, maxBuffer: 2 * 1024 * 1024 } as const;
/** A remote daemon pays an SSH handshake per call on top of the work. */
const EXEC_REMOTE = { ...EXEC, timeout: 15_000 } as const;

/** A Docker daemon to measure: this machine's (host null) or an endpoint's. */
export type MetricsDaemon = { endpointId: string | null; name: string; host: string | null };

/** Whether a daemon answered — so an unreachable one reads as that, not as empty. */
export type DaemonStatus = { endpointId: string | null; name: string; reachable: boolean };

/**
 * Stats for every running Nexus sandbox, on this machine and on each endpoint.
 *
 * Filtered by the label the launcher sets, so the user's unrelated containers
 * — and this repo's own dev stack — stay out of a view about sandboxes.
 */
export async function collectSandboxMetrics(
  opts: { withDisk?: boolean; endpoints?: MetricsDaemon[]; run?: Runner } = {},
): Promise<{ sandboxes: SandboxMetric[]; daemons: DaemonStatus[] }> {
  const daemons: MetricsDaemon[] = [
    { endpointId: null, name: "This machine", host: null },
    ...(opts.endpoints ?? []),
  ];
  const results = await Promise.all(
    daemons.map((d) => collectDaemon(d, opts.withDisk ?? false, opts.run ?? defaultRun)),
  );
  return {
    sandboxes: results.flatMap((r) => r.sandboxes),
    daemons: results.map((r, i) => ({
      endpointId: daemons[i].endpointId,
      name: daemons[i].name,
      reachable: r.reachable,
    })),
  };
}

async function collectDaemon(
  daemon: MetricsDaemon,
  withDisk: boolean,
  run: Runner,
): Promise<{ sandboxes: SandboxMetric[]; reachable: boolean }> {
  const H = dockerHostArgs({ host: daemon.host });
  const exec = daemon.host ? EXEC_REMOTE : EXEC;
  const ids = await run(
    "docker",
    [...H, "ps", "--filter", "label=nexux-sandbox=1", "--format", "{{.Names}}"],
    exec,
  )
    .then((r) => r.stdout.trim().split("\n").filter(Boolean))
    .catch(() => null);
  if (ids === null) return { sandboxes: [], reachable: false };
  if (ids.length === 0) return { sandboxes: [], reachable: true };

  const stats = await run(
    "docker",
    [
      ...H,
      "stats",
      "--no-stream",
      "--format",
      "{{.Name}}|{{.CPUPerc}}|{{.MemUsage}}|{{.MemPerc}}",
      ...ids,
    ],
    exec,
  )
    .then((r) =>
      parseDockerStats(r.stdout).map((row) => ({ ...row, endpointId: daemon.endpointId })),
    )
    .catch(() => [] as SandboxMetric[]);

  if (!withDisk) return { sandboxes: stats, reachable: true };

  // One exec per container, so this is only for the page that asked for it.
  // A container that cannot answer keeps its other metrics rather than
  // dropping out of the list entirely.
  const sandboxes = await Promise.all(
    stats.map(async (row) => {
      const disk = await run("docker", [...H, "exec", row.name, "df", "-k", "/"], exec)
        .then((r) => parseDf(r.stdout))
        .catch(() => null);
      return {
        ...row,
        diskPercent: disk?.usedPercent ?? null,
        diskUsedBytes: disk?.usedBytes ?? null,
        diskTotalBytes: disk?.totalBytes ?? null,
      };
    }),
  );
  return { sandboxes, reachable: true };
}
