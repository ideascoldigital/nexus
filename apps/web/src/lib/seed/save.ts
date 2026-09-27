/**
 * Save as seed (spec 29 phase 4): dump a database from a running sandbox and
 * make it the project's seed for that service — "I got the data how I want
 * it here; start every next sandbox from this".
 *
 * The dump is written on the instance, fetched with the same copy the
 * screenshots use, and then goes through `ingestSeed` like any upload: format
 * detected from its bytes, checked against the service, swapped in only once
 * its row exists.
 */

import { randomUUID } from "crypto";
import { createReadStream } from "fs";
import fs from "fs/promises";
import path from "path";

import { prisma } from "@nexux/db";
import { execRemote, fetchRemoteDir, renderSeedDump, SEED_DUMP_DIR, seedDumpShape } from "@nexux/sandbox";

import { sandboxTarget } from "@/lib/agent-core";
import { appendSandboxLog } from "@/lib/sandbox-manager";
import { buildSandboxStackCompose } from "@/lib/stack/sandbox-compose";
import { engineOfImage, type SeedEngine } from "./format";
import { formatBytes, ingestSeed, seedsRoot, SeedError, type SeedSummary } from "./store";

export type SandboxDatabase = {
  /** Compose service name in the sandbox. */
  service: string;
  nodeId: string;
  engine: SeedEngine;
  /** The project's current seed for it, if any — what a save would replace. */
  seed: { fileName: string; sizeBytes: number; sensitive: boolean } | null;
};

/** The databases a running sandbox has, and each one's current seed. */
export async function sandboxDatabases(sandbox: {
  projectId: string;
  stackServices: unknown;
}): Promise<SandboxDatabase[]> {
  const running = new Set(
    ((sandbox.stackServices as Array<{ name?: string }> | null) ?? []).map((s) => s.name).filter(Boolean) as string[],
  );
  if (running.size === 0) return [];
  const current = await buildSandboxStackCompose(sandbox.projectId, {});
  const dbs = current.services
    .filter((s) => running.has(s.name))
    .map((s) => ({ ...s, engine: engineOfImage(s.image) }))
    .filter((s): s is typeof s & { engine: SeedEngine } => s.engine !== null);
  const seeds = await prisma.seedData.findMany({
    where: { projectId: sandbox.projectId, stackNodeId: { in: dbs.map((d) => d.nodeId) } },
  });
  return dbs.map((d) => {
    const seed = seeds.find((s) => s.stackNodeId === d.nodeId);
    return {
      service: d.name,
      nodeId: d.nodeId,
      engine: d.engine,
      seed: seed ? { fileName: seed.fileName, sizeBytes: Number(seed.sizeBytes), sensitive: seed.sensitive } : null,
    };
  });
}

const stamp = (d: Date) => d.toISOString().slice(0, 16).replace(/[-:]/g, "").replace("T", "-");

export async function saveSandboxDataAsSeed(
  sandboxId: string,
  service: string,
): Promise<{ seed: SeedSummary; previous: { fileName: string; sizeBytes: number } | null }> {
  const sandbox = await prisma.sandbox.findUnique({ where: { id: sandboxId } });
  if (!sandbox) throw new SeedError("Sandbox not found", 404);
  if (sandbox.status !== "running") {
    throw new SeedError(`This sandbox is ${sandbox.status}, not running — there is no database to dump.`, 409);
  }
  const db = (await sandboxDatabases(sandbox)).find((d) => d.service === service);
  if (!db) throw new SeedError(`This sandbox has no database service "${service}".`, 404);

  const shape = seedDumpShape(db.engine);
  const fileName = `${service}-${sandbox.name}-${stamp(new Date())}.${shape.ext}`.replace(/[^A-Za-z0-9._-]/g, "_");
  const target = sandboxTarget(sandbox, "/", "root");
  const remoteDir = `${SEED_DUMP_DIR}/${service}`;
  const localDir = path.join(seedsRoot(sandbox.projectId), `.incoming-save-${randomUUID()}`);
  const log = await appendSandboxLog(sandboxId);
  try {
    log.append(`[nexux] save as seed: dumping ${service}`);
    const dumped = await execRemote(renderSeedDump(service, db.engine, fileName), {
      ...target,
      timeoutMs: 30 * 60_000,
    });
    if (dumped.code !== 0) {
      throw new SeedError(`The dump failed: ${`${dumped.stderr}${dumped.stdout}`.trim().slice(-300) || "no output"}`, 502);
    }
    await fs.mkdir(localDir, { recursive: true });
    const fetched = await fetchRemoteDir({ ...target, remoteDir, localDir, timeoutMs: 30 * 60_000 });
    if (fetched.code !== 0) throw new SeedError(`Could not copy the dump off the sandbox: ${fetched.stderr.trim().slice(-200)}`, 502);

    const seed = await ingestSeed({
      projectId: sandbox.projectId,
      stackNodeId: db.nodeId,
      fileName,
      // A dump of a sandbox holds whatever was put in it; the flag the
      // replaced seed carried is the best guess, and "sensitive" otherwise.
      sensitive: db.seed?.sensitive ?? true,
      source: createReadStream(path.join(localDir, fileName)),
    });
    log.append(
      `[nexux] save as seed: ${service} saved as ${fileName} (${formatBytes(seed.sizeBytes)})${db.seed ? `, replacing ${db.seed.fileName} (${formatBytes(db.seed.sizeBytes)})` : ""}`,
    );
    return { seed, previous: db.seed ? { fileName: db.seed.fileName, sizeBytes: db.seed.sizeBytes } : null };
  } catch (err) {
    log.append(`[nexux] WARN: save as seed failed for ${service}: ${err instanceof Error ? err.message : String(err)}`);
    throw err;
  } finally {
    await log.close();
    await fs.rm(localDir, { recursive: true, force: true }).catch(() => undefined);
    await execRemote(`rm -rf ${remoteDir}`, { ...target, timeoutMs: 60_000 }).catch(() => undefined);
  }
}
