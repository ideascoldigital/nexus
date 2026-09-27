/**
 * Seed data at launch (spec 29 phase 2): which seeds a sandbox restores, and
 * getting their files onto it.
 *
 * The bootstrap waits for each file's `.ready` marker, so the push only has to
 * land — it runs beside the bootstrap, not before it. `pushLocalDir` already
 * speaks every target: `docker cp` for a local container, the same through
 * `docker -H` for one on a Docker endpoint (spec 26), `scp` for a VM.
 */

import fs from "fs";
import path from "path";

import { prisma } from "@nexux/db";
import {
  execRemote,
  pushLocalDir,
  SEED_READY_MARKER,
  seedRemoteDir,
  type SandboxSeedSpec,
} from "@nexux/sandbox";

import type { SandboxStackService } from "@/lib/stack/sandbox-compose";
import { formatBytes, seedFilePath } from "./store";

export type LaunchSeed = {
  spec: SandboxSeedSpec;
  /** The directory holding just this seed's file, on this machine. */
  localDir: string;
};

/**
 * The enabled seeds of the services this sandbox will run. A seed whose file
 * is missing here is dropped with a warning rather than left for the
 * bootstrap to wait on for fifteen minutes.
 */
export async function seedsForLaunch(
  projectId: string,
  services: SandboxStackService[],
  warn: (line: string) => void,
  /** A reset asks for the seed explicitly; `enabled` only governs launches. */
  opts: { includeDisabled?: boolean } = {},
): Promise<LaunchSeed[]> {
  if (services.length === 0) return [];
  const byNode = new Map(services.map((s) => [s.nodeId, s.name]));
  const rows = await prisma.seedData.findMany({
    where: {
      projectId,
      ...(opts.includeDisabled ? {} : { enabled: true }),
      stackNodeId: { in: [...byNode.keys()] },
    },
  });
  const seeds: LaunchSeed[] = [];
  for (const row of rows) {
    const file = seedFilePath(row);
    if (!fs.existsSync(file)) {
      warn(`[nexux] seed: the file for ${byNode.get(row.stackNodeId)} is missing on this machine (${file}) — not restored`);
      continue;
    }
    seeds.push({
      localDir: path.dirname(file),
      spec: {
        service: byNode.get(row.stackNodeId)!,
        fileName: path.basename(file),
        format: row.format as SandboxSeedSpec["format"],
        gzipped: row.gzipped,
        sha256: row.sha256,
        sizeBytes: Number(row.sizeBytes),
      },
    });
  }
  return seeds;
}

type PushTarget = {
  host?: string;
  user?: string;
  privateKeyPath?: string;
  container?: string;
  dockerHost?: string | null;
};

/**
 * Copy each seed to `/opt/nexus/.seeds/<service>/` and mark it ready. The
 * marker is written last, and only after the copy succeeded, so the bootstrap
 * never reads half a file. Throws on the first failure — the caller decides
 * whether that is worth retrying (a VM whose sshd is not up yet) or final.
 */
export async function pushSeeds(
  seeds: LaunchSeed[],
  target: PushTarget,
  log: (line: string) => void,
): Promise<void> {
  const root = { ...target, user: "root" };
  for (const seed of seeds) {
    const dir = seedRemoteDir(seed.spec.service);
    const started = Date.now();
    log(`[nexux] seed: sending ${seed.spec.fileName} (${formatBytes(seed.spec.sizeBytes)}) for ${seed.spec.service}`);
    // Emptied first: a reset re-sends a replaced seed, and the old file (under
    // another name) would otherwise sit beside it for the life of the sandbox.
    const mk = await execRemote(`rm -rf ${dir} && mkdir -p ${dir}`, { ...root, timeoutMs: 60_000 });
    if (mk.code !== 0) throw new Error(`could not create ${dir}: ${mk.stderr.trim().slice(-200)}`);
    const pushed = await pushLocalDir({
      ...root,
      localDir: seed.localDir,
      remoteDir: dir,
      // A minute per 20 MB on top of five — generous for a slow uplink, and
      // still an end to a transfer that has stalled.
      timeoutMs: 5 * 60_000 + Math.ceil(seed.spec.sizeBytes / (20 * 1024 * 1024)) * 60_000,
    });
    if (pushed.code !== 0) throw new Error(`copy failed: ${pushed.stderr.trim().slice(-200)}`);
    const ready = await execRemote(`touch ${dir}/${SEED_READY_MARKER}`, { ...root, timeoutMs: 60_000 });
    if (ready.code !== 0) throw new Error(`could not mark ${dir} ready`);
    log(`[nexux] seed: ${seed.spec.service} sent in ${Math.round((Date.now() - started) / 1000)}s`);
  }
}

/**
 * For a VM: the row turns `running` when terraform returns, often before sshd
 * answers. Retry until the push lands, the sandbox goes away, or ten minutes
 * pass — the bootstrap's own wait is longer, so it notices either way.
 */
export async function pushSeedsWhenReachable(
  seeds: LaunchSeed[],
  target: () => Promise<PushTarget | null>,
  log: (line: string) => void,
  opts: { attempts?: number; intervalMs?: number } = {},
): Promise<boolean> {
  const attempts = opts.attempts ?? 40;
  let lastError = "";
  for (let i = 0; i < attempts; i++) {
    const t = await target();
    if (!t) return false; // destroyed or errored meanwhile
    try {
      await pushSeeds(seeds, t, log);
      return true;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
    await new Promise((r) => setTimeout(r, opts.intervalMs ?? 15_000));
  }
  log(`[nexux] WARN: seed data could not be sent (${lastError}) — the sandbox continues with an empty database`);
  return false;
}
