/**
 * Where seed files live and how they get there (spec 29 phase 1).
 *
 * `<dataDir>/seeds/<projectId>/<seedId>/<fileName>` — one directory per seed,
 * so replacing one is writing the new directory, then dropping the old. A file
 * is streamed in (upload or a path on this machine) to a staging directory
 * while its size and sha256 are computed, identified from its bytes, checked
 * against the service it is for, and only then given a row. Nothing half
 * written ever has a row pointing at it.
 */

import { createHash, randomUUID } from "crypto";
import { createReadStream, createWriteStream } from "fs";
import fs from "fs/promises";
import path from "path";
import { Readable, Transform } from "stream";
import { pipeline } from "stream/promises";
import { createGunzip } from "zlib";

import { getConfig } from "@nexux/config";
import { prisma } from "@nexux/db";

import {
  detectSeedFormat,
  engineOfImage,
  FORMAT_LABEL,
  isGzip,
  seedMismatch,
  type SeedEngine,
  type SeedFormat,
} from "./format";

/** Upload cap unless NEXUX_SEED_MAX_BYTES says otherwise. A path on this machine has none. */
export const DEFAULT_SEED_MAX_BYTES = 2 * 1024 ** 3;

export function seedMaxBytes(): number {
  const env = Number(process.env.NEXUX_SEED_MAX_BYTES);
  return Number.isFinite(env) && env > 0 ? env : DEFAULT_SEED_MAX_BYTES;
}

/** A refusal worth showing as is: the file or the target is wrong, not the server. */
export class SeedError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

export type SeedSummary = {
  id: string;
  stackNodeId: string;
  fileName: string;
  format: SeedFormat;
  formatLabel: string;
  gzipped: boolean;
  sizeBytes: number;
  sha256: string;
  sensitive: boolean;
  enabled: boolean;
  createdAt: string;
};

export function seedsRoot(projectId: string): string {
  return path.join(getConfig().dataDir, "seeds", projectId);
}

/** Absolute path of a seed's file on this machine. */
export function seedFilePath(seed: { id: string; projectId: string; fileName: string }): string {
  return path.join(seedsRoot(seed.projectId), seed.id, safeFileName(seed.fileName));
}

/** A name that stays inside its directory and still reads like what was given. */
export function safeFileName(name: string): string {
  const base = path.basename(name.replace(/\\/g, "/")).replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "");
  return base.slice(0, 120) || "seed";
}

function toSummary(row: {
  id: string;
  stackNodeId: string;
  fileName: string;
  format: string;
  gzipped: boolean;
  sizeBytes: bigint;
  sha256: string;
  sensitive: boolean;
  enabled: boolean;
  createdAt: Date;
}): SeedSummary {
  const format = row.format as SeedFormat;
  return {
    id: row.id,
    stackNodeId: row.stackNodeId,
    fileName: row.fileName,
    format,
    formatLabel: FORMAT_LABEL[format] ?? row.format,
    gzipped: row.gzipped,
    sizeBytes: Number(row.sizeBytes),
    sha256: row.sha256,
    sensitive: row.sensitive,
    enabled: row.enabled,
    createdAt: row.createdAt.toISOString(),
  };
}

export async function listSeeds(projectId: string): Promise<SeedSummary[]> {
  const rows = await prisma.seedData.findMany({ where: { projectId }, orderBy: { createdAt: "asc" } });
  // A node deleted from the canvas cascades its row but not its directory.
  await sweepOrphanSeedDirs(projectId, new Set(rows.map((r) => r.id))).catch(() => undefined);
  return rows.map(toSummary);
}

/** The service a seed would go into, or why it cannot. */
async function seedTarget(projectId: string, stackNodeId: string): Promise<{ engine: SeedEngine; image: string }> {
  const node = await prisma.stackNode.findFirst({
    where: { id: stackNodeId, projectId },
    select: { kind: true, image: true },
  });
  if (!node) throw new SeedError("That stack node does not exist — save the canvas first.", 404);
  const engine = node.kind === "service" ? engineOfImage(node.image) : null;
  if (!engine) {
    throw new SeedError(
      `${node.image ?? "This node"} is not a database a seed can restore into (PostgreSQL, MySQL/MariaDB or MongoDB).`,
    );
  }
  return { engine, image: node.image! };
}

/** The first bytes of what the file holds — decompressed first when it is gzip. */
async function readHead(file: string, bytes = 64 * 1024): Promise<{ head: Buffer; gzipped: boolean }> {
  const handle = await fs.open(file, "r");
  let raw: Buffer;
  try {
    const buf = Buffer.alloc(bytes);
    const { bytesRead } = await handle.read(buf, 0, bytes, 0);
    raw = buf.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
  if (!isGzip(raw)) return { head: raw, gzipped: false };

  const chunks: Buffer[] = [];
  let total = 0;
  const source = createReadStream(file);
  const gunzip = createGunzip();
  await new Promise<void>((resolve) => {
    const done = () => {
      source.destroy();
      gunzip.destroy();
      resolve();
    };
    gunzip.on("data", (c: Buffer) => {
      chunks.push(c);
      total += c.length;
      if (total >= bytes) done();
    });
    gunzip.on("end", done);
    gunzip.on("error", done); // a truncated gzip still yields its first bytes
    source.on("error", done);
    source.pipe(gunzip);
  });
  return { head: Buffer.concat(chunks).subarray(0, bytes), gzipped: true };
}

/**
 * Stream a file in and make it the seed for a service, replacing any seed it
 * had. `maxBytes` stops an upload mid-stream rather than after filling a disk.
 */
export async function ingestSeed(opts: {
  projectId: string;
  stackNodeId: string;
  fileName: string;
  sensitive: boolean;
  source: Readable;
  maxBytes?: number;
}): Promise<SeedSummary> {
  const { engine, image } = await seedTarget(opts.projectId, opts.stackNodeId);
  const fileName = safeFileName(opts.fileName);
  const root = seedsRoot(opts.projectId);
  const staging = path.join(root, `.incoming-${randomUUID()}`);
  await fs.mkdir(staging, { recursive: true });
  const stagedFile = path.join(staging, fileName);

  try {
    const hash = createHash("sha256");
    let size = 0;
    const limit = opts.maxBytes ?? Infinity;
    const meter = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        size += chunk.length;
        if (size > limit) {
          cb(new SeedError(`The file is larger than the ${formatBytes(limit)} upload limit. Pick it from this machine instead, or raise NEXUX_SEED_MAX_BYTES.`, 413));
          return;
        }
        hash.update(chunk);
        cb(null, chunk);
      },
    });
    await pipeline(opts.source, meter, createWriteStream(stagedFile));
    if (size === 0) throw new SeedError("The file is empty.");

    const { head, gzipped } = await readHead(stagedFile);
    const format = detectSeedFormat(head, engine);
    if (!format) {
      throw new SeedError(
        `${opts.fileName} is not a dump this can restore — expected a PostgreSQL (plain or pg_dump -Fc), MySQL/MariaDB or mongodump archive, optionally gzipped.`,
      );
    }
    const mismatch = seedMismatch(format, engine, image);
    if (mismatch) throw new SeedError(mismatch);

    const sha256 = hash.digest("hex");
    const { created, replaced } = await prisma.$transaction(async (tx) => {
      const old = await tx.seedData.findUnique({ where: { stackNodeId: opts.stackNodeId } });
      if (old) await tx.seedData.delete({ where: { id: old.id } });
      const row = await tx.seedData.create({
        data: {
          projectId: opts.projectId,
          stackNodeId: opts.stackNodeId,
          fileName,
          format,
          gzipped,
          sizeBytes: BigInt(size),
          sha256,
          sensitive: opts.sensitive,
        },
      });
      return { created: row, replaced: old };
    });
    await fs.rename(staging, path.join(root, created.id));
    if (replaced) await fs.rm(path.join(root, replaced.id), { recursive: true, force: true });
    return toSummary(created);
  } catch (err) {
    await fs.rm(staging, { recursive: true, force: true }).catch(() => undefined);
    throw err;
  }
}

/** A file already on this machine: read in place, copied into the seeds dir. */
export async function ingestSeedFromPath(opts: {
  projectId: string;
  stackNodeId: string;
  filePath: string;
  sensitive: boolean;
}): Promise<SeedSummary> {
  if (!path.isAbsolute(opts.filePath)) throw new SeedError("Give the file's full path.");
  const stat = await fs.stat(opts.filePath).catch(() => null);
  if (!stat) throw new SeedError(`No file at ${opts.filePath}.`, 404);
  if (!stat.isFile()) throw new SeedError(`${opts.filePath} is not a file.`);
  return ingestSeed({
    projectId: opts.projectId,
    stackNodeId: opts.stackNodeId,
    fileName: path.basename(opts.filePath),
    sensitive: opts.sensitive,
    source: createReadStream(opts.filePath),
  });
}

export async function updateSeed(
  projectId: string,
  seedId: string,
  patch: { sensitive?: boolean; enabled?: boolean },
): Promise<SeedSummary> {
  const seed = await prisma.seedData.findFirst({ where: { id: seedId, projectId } });
  if (!seed) throw new SeedError("Seed not found", 404);
  return toSummary(await prisma.seedData.update({ where: { id: seedId }, data: patch }));
}

export async function deleteSeed(projectId: string, seedId: string): Promise<void> {
  const seed = await prisma.seedData.findFirst({ where: { id: seedId, projectId } });
  if (!seed) throw new SeedError("Seed not found", 404);
  await prisma.seedData.delete({ where: { id: seedId } });
  await fs.rm(path.join(seedsRoot(projectId), seedId), { recursive: true, force: true });
}

/**
 * Remove seed directories no row points at: a node deleted from the canvas
 * cascades its row, and nothing else would ever remove its file. A staging
 * directory is left alone for a day — it may be an upload in progress.
 */
export async function sweepOrphanSeedDirs(projectId: string, keep: Set<string>): Promise<string[]> {
  const root = seedsRoot(projectId);
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  const removed: string[] = [];
  for (const e of entries) {
    if (!e.isDirectory() || keep.has(e.name)) continue;
    const dir = path.join(root, e.name);
    if (e.name.startsWith(".incoming-")) {
      const stat = await fs.stat(dir).catch(() => null);
      if (!stat || Date.now() - stat.mtimeMs < 24 * 3600_000) continue;
    }
    await fs.rm(dir, { recursive: true, force: true });
    removed.push(e.name);
  }
  return removed;
}

export function formatBytes(n: number): string {
  if (!Number.isFinite(n)) return "unlimited";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 10 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}
