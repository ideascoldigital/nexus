import * as lancedb from "@lancedb/lancedb";
import path from "path";
import fs from "fs";
import crypto from "crypto";
import { getConfig } from "@nexux/config";

const TABLE_NAME = "chunks";
const INDEXES_ROOT = path.join(getConfig().dataDir, "indexes");

export type Bucket = "repo" | "conversations" | "project-data";

export type ChunkRecord = {
  id: string;
  source_type: string;
  source_id: string;
  repo_id: string;
  file_path: string;
  chunk_index: number;
  start_line: number;
  end_line: number;
  heading: string;
  text: string;
  vector: number[];
  updated_at: number;
};

export type SearchFilters = {
  sourceTypes?: string[];
  repoIds?: string[];
};

export function repoKeyFor(repo: { repoUrl?: string | null; localPath?: string | null }): string {
  const url = (repo.repoUrl ?? "").trim();
  if (url) {
    const norm = url.replace(/\.git$/i, "").replace(/\/+$/, "").toLowerCase();
    return "url-" + sha1(norm).slice(0, 16);
  }
  const local = (repo.localPath ?? "").trim();
  if (local) {
    return "path-" + sha1(path.resolve(local)).slice(0, 16);
  }
  return "unknown-" + sha1(Math.random().toString()).slice(0, 16);
}

export function bucketDir(bucket: Bucket, key: string): string {
  const safeKey = key.replace(/[^a-zA-Z0-9_-]/g, "_");
  if (bucket === "repo") return path.join(INDEXES_ROOT, "repos", safeKey, "lancedb");
  if (bucket === "conversations")
    return path.join(INDEXES_ROOT, "conversations", safeKey, "lancedb");
  return path.join(INDEXES_ROOT, "project-data", safeKey, "lancedb");
}

export class VectorStore {
  constructor(
    private db: lancedb.Connection,
    private table: lancedb.Table,
    readonly bucket: Bucket,
    readonly key: string,
    readonly dimensions: number,
  ) {}

  static async open(bucket: Bucket, key: string, dimensions: number): Promise<VectorStore> {
    const dir = bucketDir(bucket, key);
    fs.mkdirSync(dir, { recursive: true });
    try {
      return await openInternal(bucket, key, dimensions, dir);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (isLanceCorruptionError(message)) {
        console.warn(
          `[embeddings] LanceDB corruption at ${dir}, recreating. Cause: ${message}`,
        );
        try {
          fs.rmSync(dir, { recursive: true, force: true });
        } catch {
          // ignore
        }
        fs.mkdirSync(dir, { recursive: true });
        return await openInternal(bucket, key, dimensions, dir);
      }
      throw err;
    }
  }

  async upsertChunks(records: ChunkRecord[]): Promise<void> {
    if (!records.length) return;
    const ids = records.map((r) => `'${r.id.replace(/'/g, "''")}'`).join(",");
    await this.table.delete(`id IN (${ids})`);
    await this.table.add(records);
  }

  async deleteBySource(sourceType: string, sourceId: string): Promise<void> {
    const esc = sourceId.replace(/'/g, "''");
    await this.table.delete(
      `source_type = '${sourceType}' AND source_id = '${esc}'`,
    );
  }

  async dropAll(): Promise<void> {
    try {
      const names = await this.db.tableNames();
      if (names.includes(TABLE_NAME)) {
        await this.db.dropTable(TABLE_NAME);
      }
    } catch {
      // ignore
    }
    const dir = bucketDir(this.bucket, this.key);
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
    fs.mkdirSync(dir, { recursive: true });
  }

  async search(
    vector: number[],
    k: number,
    filters?: SearchFilters,
  ): Promise<(ChunkRecord & { _distance: number })[]> {
    let query = this.table.search(vector).limit(k);

    const where: string[] = [];
    if (filters?.sourceTypes?.length) {
      const list = filters.sourceTypes
        .map((s) => `'${s.replace(/'/g, "''")}'`)
        .join(",");
      where.push(`source_type IN (${list})`);
    }
    if (filters?.repoIds?.length) {
      const list = filters.repoIds
        .map((s) => `'${s.replace(/'/g, "''")}'`)
        .join(",");
      where.push(`repo_id IN (${list})`);
    }
    if (where.length) query = query.where(where.join(" AND "));

    const results = await query.toArray();
    return results as (ChunkRecord & { _distance: number })[];
  }
}

async function openInternal(
  bucket: Bucket,
  key: string,
  dimensions: number,
  dir: string,
): Promise<VectorStore> {
  const db = await lancedb.connect(dir);
  const names = await db.tableNames();

  let table: lancedb.Table;
  if (names.includes(TABLE_NAME)) {
    table = await db.openTable(TABLE_NAME);
  } else {
    const seed: ChunkRecord = {
      id: "__seed__",
      source_type: "_seed",
      source_id: "_seed",
      repo_id: "",
      file_path: "",
      chunk_index: 0,
      start_line: 0,
      end_line: 0,
      heading: "",
      text: "",
      vector: new Array(dimensions).fill(0),
      updated_at: 0,
    };
    table = await db.createTable(TABLE_NAME, [seed]);
    await table.delete("source_type = '_seed'");
  }

  return new VectorStore(db, table, bucket, key, dimensions);
}

function isLanceCorruptionError(message: string): boolean {
  return /LanceError\(IO\)/i.test(message) && /Not found:.*\.lance/i.test(message);
}

function sha1(s: string): string {
  return crypto.createHash("sha1").update(s).digest("hex");
}

export function projectSlug(projectId: string): string {
  return projectId.slice(0, 8);
}
