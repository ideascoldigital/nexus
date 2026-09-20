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
// Cloud sandboxes are out of scope here. They are reached over ssh, their
// metrics cost a network round trip each, and a box that is merely slow would
// hold up the whole response; that belongs behind its own explicitly-requested
// call rather than a poll.

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { parseDf } from "./system-metrics";

const run = promisify(execFile);

export type SandboxMetric = {
  /** The container name, which is the sandbox name for a local sandbox. */
  name: string;
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
      cpuPercent: parsePercent(cpu ?? ""),
      memPercent: parsePercent(memPct ?? ""),
      memUsedBytes: used ? parseSize(used) : null,
      memLimitBytes: limit ? parseSize(limit) : null,
    });
  }
  return rows;
}

const EXEC = { timeout: 6000, maxBuffer: 2 * 1024 * 1024 } as const;

/**
 * Stats for every running Nexus sandbox on this machine.
 *
 * Filtered by the label the launcher sets, so the user's unrelated containers
 * — and this repo's own dev stack — stay out of a view about sandboxes.
 */
export async function collectSandboxMetrics(
  opts: { withDisk?: boolean } = {},
): Promise<SandboxMetric[]> {
  const ids = await run(
    "docker",
    ["ps", "--filter", "label=nexux-sandbox=1", "--format", "{{.Names}}"],
    EXEC,
  )
    .then((r) => r.stdout.trim().split("\n").filter(Boolean))
    .catch(() => [] as string[]);
  if (ids.length === 0) return [];

  const stats = await run(
    "docker",
    [
      "stats",
      "--no-stream",
      "--format",
      "{{.Name}}|{{.CPUPerc}}|{{.MemUsage}}|{{.MemPerc}}",
      ...ids,
    ],
    EXEC,
  )
    .then((r) => parseDockerStats(r.stdout))
    .catch(() => [] as SandboxMetric[]);

  if (!opts.withDisk) return stats;

  // One exec per container, so this is only for the page that asked for it.
  // A container that cannot answer keeps its other metrics rather than
  // dropping out of the list entirely.
  return Promise.all(
    stats.map(async (row) => {
      const disk = await run("docker", ["exec", row.name, "df", "-k", "/"], EXEC)
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
}
