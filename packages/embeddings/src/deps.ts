// The outside world that indexProject/searchProject touch: the database, the
// embedder, the vector stores, the filesystem. Collected behind one type so
// tests can supply fakes — a real run needs a live Ollama daemon and LanceDB
// on disk, neither of which CI has.
//
// Production callers pass nothing and get defaultDeps().

import fs from "fs";
import { getEmbedder, type EmbeddingProvider } from "./embedder";
import { VectorStore, type Bucket, type ChunkRecord } from "./store";
import { scanRepo } from "./scan";

// @nexux/db builds its Prisma client at module load and throws without
// DATABASE_URL, so it is required lazily: importing this module (or anything
// that re-exports it) must not need a database. Only defaultDeps() does.
function db() {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return (require("@nexux/db") as typeof import("@nexux/db")).prisma;
}

/** The store surface indexing and search need; VectorStore satisfies it. */
export type IndexStore = {
  dropAll(): Promise<void>;
  deleteBySource(sourceType: string, sourceId: string): Promise<void>;
  upsertChunks(records: ChunkRecord[]): Promise<void>;
  search(
    vector: number[],
    k: number,
    filters?: { sourceTypes?: string[]; repoIds?: string[] }
  ): Promise<(ChunkRecord & { _distance: number })[]>;
};

/** The embedder surface indexing needs. */
export type IndexEmbedder = {
  ensureReady(): Promise<void>;
  embed(text: string): Promise<{ vector: number[] }>;
};

/** A file discovered under a repo checkout. */
export type ScannedFileRef = {
  absolutePath: string;
  relativePath: string;
};

/**
 * Only the two `embeddingIndex` operations indexing performs, plus the project
 * read. Typed loosely on purpose: mirroring Prisma's generated argument types
 * here would couple this seam to the schema for no gain.
 */
export type IndexDb = {
  findProject(projectId: string): Promise<unknown | null>;
  /** Search only needs the repositories, not the whole indexable graph. */
  findProjectRepos(projectId: string): Promise<{
    repositories: { id: string; repoUrl?: string | null; localPath?: string | null }[];
  } | null>;
  findIndexEntry(where: {
    bucket: string;
    indexKey: string;
    sourceType: string;
    sourceId: string;
  }): Promise<{
    id: string;
    projectId: string;
    contentHash: string;
    provider: string;
  } | null>;
  touchIndexEntry(id: string, projectId: string): Promise<void>;
  upsertIndexEntry(entry: {
    bucket: string;
    indexKey: string;
    sourceType: string;
    sourceId: string;
    projectId: string;
    contentHash: string;
    chunkCount: number;
    provider: string;
    dimensions: number;
  }): Promise<void>;
  deleteIndexEntries(where: {
    bucket?: string;
    indexKey?: string;
    projectId?: string;
  }): Promise<void>;
};

export type EmbeddingDeps = {
  db: IndexDb;
  getEmbedder(provider: EmbeddingProvider): IndexEmbedder;
  openStore(
    bucket: Bucket,
    key: string,
    dimensions: number
  ): Promise<IndexStore>;
  scanRepo(rootPath: string): ScannedFileRef[];
  readFile(absolutePath: string): string;
  now(): number;
};

/** Real implementations — prisma, Ollama, LanceDB, the filesystem. */
export function defaultDeps(): EmbeddingDeps {
  return {
    db: {
      findProject: (projectId) =>
        db().project.findUnique({
          where: { id: projectId },
          include: {
            repositories: true,
            features: true,
            document: { include: { sections: true } },
            projectSkills: { include: { skill: true } },
            conversations: {
              include: {
                messages: {
                  where: {
                    role: { in: ["user", "assistant"] },
                    messageType: { in: ["text"] },
                  },
                  orderBy: { createdAt: "asc" },
                },
              },
            },
          },
        }),
      findProjectRepos: (projectId) =>
        db().project.findUnique({
          where: { id: projectId },
          include: { repositories: true },
        }),
      findIndexEntry: (where) =>
        db().embeddingIndex.findUnique({
          where: { bucket_indexKey_sourceType_sourceId: where },
        }),
      touchIndexEntry: async (id, projectId) => {
        await db().embeddingIndex.update({
          where: { id },
          data: { projectId, indexedAt: new Date() },
        });
      },
      upsertIndexEntry: async (entry) => {
        const {
          bucket,
          indexKey,
          sourceType,
          sourceId,
          projectId,
          contentHash,
          chunkCount,
          provider,
          dimensions,
        } = entry;
        await db().embeddingIndex.upsert({
          where: {
            bucket_indexKey_sourceType_sourceId: {
              bucket,
              indexKey,
              sourceType,
              sourceId,
            },
          },
          update: {
            projectId,
            contentHash,
            chunkCount,
            provider,
            dimensions,
            indexedAt: new Date(),
          },
          create: {
            projectId,
            bucket,
            indexKey,
            sourceType,
            sourceId,
            contentHash,
            chunkCount,
            provider,
            dimensions,
          },
        });
      },
      deleteIndexEntries: async (where) => {
        await db().embeddingIndex.deleteMany({ where });
      },
    },
    getEmbedder: (provider) => getEmbedder(provider),
    openStore: (bucket, key, dimensions) =>
      VectorStore.open(bucket, key, dimensions),
    scanRepo,
    readFile: (absolutePath) => fs.readFileSync(absolutePath, "utf8"),
    now: () => Date.now(),
  };
}
