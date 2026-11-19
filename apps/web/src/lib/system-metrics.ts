// What this machine has left: memory, CPU, disk and (where it exists) GPU.
//
// Written because a host filled its disk and nothing said so. The failure that
// followed was a docker pull dying half way through extracting a layer, which
// reports itself as "could not pull — check the registry credentials": the
// symptom names the wrong cause, and the real one was visible for weeks to
// anyone who ran `df`. A number in the status bar is cheaper than that.
//
// Two platform traps this deliberately avoids, both of which produce a figure
// that is wrong rather than missing:
//
//   - `os.freemem()` on macOS counts cached and compressed pages as used, so a
//     healthy machine reports ~1% free and the bar would sit permanently red.
//     `memory_pressure` is what Activity Monitor agrees with.
//   - `df /` on macOS answers for the read-only system volume (25% used), not
//     the data volume the user's files and Docker images are on (96% here).
//     `df .` resolves to the volume this process actually writes to, and is
//     correct on Linux too.
//
// The parsers are exported separately from the commands that feed them: the
// interesting cases are malformed and absent output, and those are worth a
// test that does not need the machine to be in a particular state.

import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

/** A single measurement. `null` means "could not be read", never "zero". */
export type Metric = {
  /** 0–100, or null when this machine cannot answer. */
  usedPercent: number | null;
  /** Bytes, when the source gives absolute numbers. */
  usedBytes?: number | null;
  totalBytes?: number | null;
  /** Shown on hover — the model name, the mount point, the core count. */
  detail?: string | null;
};

export type SystemMetrics = {
  memory: Metric;
  cpu: Metric;
  disk: Metric;
  /** Absent on machines with no GPU we can measure, which is most of them. */
  gpu: Metric | null;
  platform: string;
  hostname: string;
  /** When this was taken — the client shows staleness rather than guessing. */
  at: string;
};

// ---- parsers (pure) --------------------------------------------------------

/**
 * `memory_pressure`'s free percentage, which is what macOS itself reports as
 * available. The line reads "System-wide memory free percentage: 67%".
 */
export function parseMemoryPressure(stdout: string): number | null {
  const match = stdout.match(/free percentage:\s*(\d+(?:\.\d+)?)%/i);
  if (!match) return null;
  const free = Number(match[1]);
  if (!Number.isFinite(free) || free < 0 || free > 100) return null;
  return round(100 - free);
}

/**
 * The used percentage from a `df -k` line. Parsed off the `NN%` field rather
 * than by column index: the filesystem name can contain spaces, and macOS and
 * Linux disagree about how many columns precede the capacity.
 */
export function parseDf(
  stdout: string,
): { usedPercent: number; usedBytes: number; totalBytes: number; mount: string } | null {
  const lines = stdout.trim().split("\n");
  if (lines.length < 2) return null;
  const line = lines[lines.length - 1];
  const pct = line.match(/(\d+)%/);
  if (!pct) return null;
  const fields = line.split(/\s+/);
  // 1k blocks: total, used — the two numeric fields before the percentage.
  const totalKb = Number(fields[1]);
  const usedKb = Number(fields[2]);
  const mount = fields[fields.length - 1] ?? "";
  const usedPercent = Number(pct[1]);
  if (!Number.isFinite(usedPercent)) return null;
  return {
    usedPercent,
    usedBytes: Number.isFinite(usedKb) ? usedKb * 1024 : 0,
    totalBytes: Number.isFinite(totalKb) ? totalKb * 1024 : 0,
    mount,
  };
}

/**
 * `nvidia-smi --query-gpu=name,utilization.gpu,memory.used,memory.total
 *  --format=csv,noheader,nounits`, one line per card. Only the first is
 * reported: a status bar has room for one number, and a second card is a
 * detail for the stats page rather than the bar.
 */
export function parseNvidiaSmi(stdout: string): Metric | null {
  const line = stdout.trim().split("\n")[0];
  if (!line) return null;
  const parts = line.split(",").map((p) => p.trim());
  if (parts.length < 4) return null;
  const [name, util, usedMb, totalMb] = parts;
  const usedPercent = Number(util);
  if (!Number.isFinite(usedPercent)) return null;
  const used = Number(usedMb);
  const total = Number(totalMb);
  return {
    usedPercent: round(usedPercent),
    usedBytes: Number.isFinite(used) ? used * 1024 * 1024 : null,
    totalBytes: Number.isFinite(total) ? total * 1024 * 1024 : null,
    detail: name || null,
  };
}

/**
 * CPU load as a percentage of capacity.
 *
 * The 1-minute load average over core count, which is a *queue* length rather
 * than a utilisation, so it can exceed 100 and is clamped. It is the only
 * figure available without sampling /proc twice a second, and for "is this
 * machine struggling" it answers the question.
 */
export function loadPercent(load1: number, cores: number): number | null {
  if (!Number.isFinite(load1) || !Number.isFinite(cores) || cores <= 0) {
    return null;
  }
  return round(Math.min(100, (load1 / cores) * 100));
}

function round(n: number): number {
  return Math.round(n * 10) / 10;
}

// ---- collection (shells out) -----------------------------------------------

const EXEC = { timeout: 4000, maxBuffer: 1024 * 1024 } as const;

async function memory(): Promise<Metric> {
  const totalBytes = os.totalmem();
  if (process.platform === "darwin") {
    const pressure = await run("memory_pressure", [], EXEC)
      .then((r) => parseMemoryPressure(r.stdout))
      .catch(() => null);
    if (pressure !== null) {
      return {
        usedPercent: pressure,
        usedBytes: Math.round((pressure / 100) * totalBytes),
        totalBytes,
      };
    }
  }
  // Linux's free/total is honest about page cache, so os.freemem() is usable.
  const used = totalBytes - os.freemem();
  return {
    usedPercent: round((used / totalBytes) * 100),
    usedBytes: used,
    totalBytes,
  };
}

async function disk(): Promise<Metric> {
  // `.` rather than `/`: on macOS the root is a read-only system volume and
  // the data volume is what fills up.
  const parsed = await run("df", ["-k", "."], EXEC)
    .then((r) => parseDf(r.stdout))
    .catch(() => null);
  if (!parsed) return { usedPercent: null };
  return {
    usedPercent: parsed.usedPercent,
    usedBytes: parsed.usedBytes,
    totalBytes: parsed.totalBytes,
    detail: parsed.mount,
  };
}

async function gpu(): Promise<Metric | null> {
  // No nvidia-smi is the normal case, not a failure: Apple Silicon has no
  // equivalent without a native dependency, and most Linux hosts have no card.
  return run(
    "nvidia-smi",
    [
      "--query-gpu=name,utilization.gpu,memory.used,memory.total",
      "--format=csv,noheader,nounits",
    ],
    EXEC,
  )
    .then((r) => parseNvidiaSmi(r.stdout))
    .catch(() => null);
}

export async function collectSystemMetrics(): Promise<SystemMetrics> {
  const cores = os.cpus().length;
  const [mem, dsk, card] = await Promise.all([memory(), disk(), gpu()]);
  return {
    memory: mem,
    cpu: {
      usedPercent: loadPercent(os.loadavg()[0], cores),
      detail: `${cores} cores · load ${os
        .loadavg()
        .map((n) => n.toFixed(2))
        .join(" ")}`,
    },
    disk: dsk,
    gpu: card,
    platform: process.platform,
    hostname: os.hostname(),
    at: new Date().toISOString(),
  };
}
