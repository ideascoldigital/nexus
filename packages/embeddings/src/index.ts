// Every external dependency (prisma, Ollama, LanceDB, the filesystem) is
// reached through ./deps so callers can substitute fakes in tests.
import crypto from "crypto";
import { EmbeddingProvider, dimensionsFor } from "./embedder";
import { ChunkRecord, Bucket, repoKeyFor, projectSlug } from "./store";
import { Chunk, SourceType, chunkForFile, chunkPlain } from "./chunker";
import {
  attachRepoId,
  filterRepoHits,
  rankAndSlice,
  type SearchHit,
} from "./ranking";
import {
  defaultDeps,
  type EmbeddingDeps,
  type IndexEmbedder,
  type IndexStore,
} from "./deps";

export type { EmbeddingDeps } from "./deps";

export type IndexMode = "full" | "incremental";

export type IndexReport = {
  projectId: string;
  provider: EmbeddingProvider;
  dimensions: number;
  scanned: number;
  embedded: number;
  skipped: number;
  removed: number;
  durationMs: number;
  buckets: {
    repos: number;
    conversations: number;
    projectData: number;
  };
};

export type IndexOptions = {
  mode?: IndexMode;
  provider?: EmbeddingProvider;
  /** Ollama address, already resolved by the caller (see resolveOllamaHost). */
  ollamaHost?: string;
};

export async function indexProject(
  projectId: string,
  opts: IndexOptions = {},
  deps: EmbeddingDeps = defaultDeps(),
): Promise<IndexReport> {
  try {
    return await indexProjectCore(projectId, opts, deps);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (isLanceCorruption(message) && opts.mode !== "full") {
      console.warn(
        `[embeddings] LanceDB corruption mid-index for ${projectId}, retrying full reindex.`,
      );
      await dropProjectIndex(projectId, deps);
      return indexProjectCore(projectId, { ...opts, mode: "full" }, deps);
    }
    throw err;
  }
}

export function isLanceCorruption(message: string): boolean {
  return /LanceError\(IO\)/i.test(message) && /Not found:.*\.lance/i.test(message);
}

/** Project shape indexing reads; `defaultDeps` returns it from prisma. */
type IndexableProject = {
  repositories: { id: string; localPath?: string | null; repoUrl?: string | null }[];
  features: {
    id: string;
    title: string;
    description?: string | null;
    aiRefinement?: string | null;
  }[];
  document?: {
    sections: { id: string; key: string; title: string; content: string }[];
  } | null;
  projectSkills: {
    skill?: {
      id: string;
      name: string;
      description?: string | null;
      body?: string | null;
    } | null;
  }[];
  conversations: {
    id: string;
    name?: string | null;
    messages: {
      id: string;
      role: string;
      agentRole?: string | null;
      content?: string | null;
    }[];
  }[];
};

async function indexProjectCore(
  projectId: string,
  opts: IndexOptions,
  deps: EmbeddingDeps,
): Promise<IndexReport> {
  const started = deps.now();
  const mode: IndexMode = opts.mode ?? "incremental";
  const provider: EmbeddingProvider = opts.provider ?? "ollama-nomic";
  const dimensions = dimensionsFor(provider);
  const slug = projectSlug(projectId);

  const project = (await deps.db.findProject(projectId)) as IndexableProject | null;
  if (!project) throw new Error(`Project ${projectId} not found`);

  const embedder = deps.getEmbedder(provider, opts.ollamaHost);
  await embedder.ensureReady();

  let scanned = 0;
  let embedded = 0;
  let skipped = 0;
  const buckets = { repos: 0, conversations: 0, projectData: 0 };

  // Bucket: project-data (features, document sections, skills) — per-project
  const projectDataStore = await deps.openStore("project-data", slug, dimensions);
  if (mode === "full") {
    await projectDataStore.dropAll();
    await deps.db.deleteIndexEntries({
      bucket: "project-data",
      indexKey: slug,
    });
  }

  if (project.document) {
    for (const section of project.document.sections) {
      const text = `# ${section.title}\n\n${section.content}`;
      const result = await indexSource({
        store: projectDataStore,
        embedder,
        db: deps.db,
        now: deps.now,
        bucket: "project-data",
        indexKey: slug,
        projectId,
        sourceType: "document_section",
        sourceId: section.id,
        repoId: "",
        filePath: `document/${section.key}`,
        text,
        provider,
        dimensions,
        mode,
      });
      scanned++;
      if (result === "embedded") {
        embedded++;
        buckets.projectData++;
      } else if (result === "skipped") {
        skipped++;
      }
    }
  }

  for (const feature of project.features) {
    const text = [
      `# ${feature.title}`,
      feature.description ?? "",
      feature.aiRefinement ?? "",
    ]
      .filter(Boolean)
      .join("\n\n");
    const result = await indexSource({
      store: projectDataStore,
      embedder,
      db: deps.db,
      now: deps.now,
      bucket: "project-data",
      indexKey: slug,
      projectId,
      sourceType: "feature",
      sourceId: feature.id,
      repoId: "",
      filePath: `feature/${feature.id}`,
      text,
      provider,
      dimensions,
      mode,
    });
    scanned++;
    if (result === "embedded") {
      embedded++;
      buckets.projectData++;
    } else if (result === "skipped") {
      skipped++;
    }
  }

  for (const ps of project.projectSkills) {
    const skill = ps.skill;
    if (!skill) continue;
    const text = [`# ${skill.name}`, skill.description ?? "", skill.body ?? ""]
      .filter(Boolean)
      .join("\n\n");
    const result = await indexSource({
      store: projectDataStore,
      embedder,
      db: deps.db,
      now: deps.now,
      bucket: "project-data",
      indexKey: slug,
      projectId,
      sourceType: "skill",
      sourceId: skill.id,
      repoId: "",
      filePath: `skill/${skill.name}`,
      text,
      provider,
      dimensions,
      mode,
    });
    scanned++;
    if (result === "embedded") {
      embedded++;
      buckets.projectData++;
    } else if (result === "skipped") {
      skipped++;
    }
  }

  // Bucket: conversations — per-project
  const convStore = await deps.openStore("conversations", slug, dimensions);
  if (mode === "full") {
    await convStore.dropAll();
    await deps.db.deleteIndexEntries({
      bucket: "conversations",
      indexKey: slug,
    });
  }

  const MIN_MSG_CHARS = 20;
  for (const conv of project.conversations) {
    const convLabel = conv.name ?? conv.id.slice(0, 8);
    for (const msg of conv.messages) {
      const content = msg.content?.trim() ?? "";
      if (content.length < MIN_MSG_CHARS) continue;
      const header = `# ${msg.role}${msg.agentRole ? ` (${msg.agentRole})` : ""} in ${convLabel}`;
      const text = `${header}\n\n${content}`;
      const result = await indexSource({
        store: convStore,
        embedder,
        db: deps.db,
        now: deps.now,
        bucket: "conversations",
        indexKey: slug,
        projectId,
        sourceType: "message",
        sourceId: msg.id,
        repoId: "",
        filePath: `conversation/${conv.id}/message/${msg.id}`,
        text,
        provider,
        dimensions,
        mode,
      });
      scanned++;
      if (result === "embedded") {
        embedded++;
        buckets.conversations++;
      } else if (result === "skipped") {
        skipped++;
      }
    }
  }

  // Bucket: repo — shared by repoKey across projects
  for (const repo of project.repositories) {
    if (!repo.localPath) continue;
    const key = repoKeyFor(repo);
    const repoStore = await deps.openStore("repo", key, dimensions);
    if (mode === "full") {
      await repoStore.dropAll();
      await deps.db.deleteIndexEntries({ bucket: "repo", indexKey: key });
    }
    const files = deps.scanRepo(repo.localPath);
    for (const file of files) {
      let content: string;
      try {
        content = deps.readFile(file.absolutePath);
      } catch {
        continue;
      }
      const result = await indexSource({
        store: repoStore,
        embedder,
        db: deps.db,
        now: deps.now,
        bucket: "repo",
        indexKey: key,
        projectId,
        sourceType: "file",
        sourceId: file.relativePath,
        repoId: repo.id,
        filePath: file.relativePath,
        text: content,
        chunker: () => chunkForFile(file.relativePath, content),
        provider,
        dimensions,
        mode,
      });
      scanned++;
      if (result === "embedded") {
        embedded++;
        buckets.repos++;
      } else if (result === "skipped") {
        skipped++;
      }
    }
  }

  return {
    projectId,
    provider,
    dimensions,
    scanned,
    embedded,
    skipped,
    removed: 0,
    durationMs: deps.now() - started,
    buckets,
  };
}

export async function dropProjectIndex(
  projectId: string,
  deps: EmbeddingDeps = defaultDeps(),
): Promise<void> {
  const slug = projectSlug(projectId);
  const dims = dimensionsFor("ollama-nomic");

  const projectData = await deps.openStore("project-data", slug, dims);
  await projectData.dropAll();

  const conv = await deps.openStore("conversations", slug, dims);
  await conv.dropAll();

  // Repos: only drop tracking rows for this project. Vector store stays (shared).
  await deps.db.deleteIndexEntries({ projectId });
}

// Defined in ./ranking (pure, unit-tested); re-exported so importers of
// @nexux/embeddings keep seeing it here.
export type { SearchHit };

export type GroupedSearchResults = {
  repos: SearchHit[];
  conversations: SearchHit[];
  projectData: SearchHit[];
};

export type SearchOptions = {
  k?: number;
  sourceTypes?: SourceType[];
  repoIds?: string[];
  provider?: EmbeddingProvider;
  /** Ollama address, already resolved by the caller (see resolveOllamaHost). */
  ollamaHost?: string;
};

export async function searchProject(
  projectId: string,
  query: string,
  opts: SearchOptions = {},
  deps: EmbeddingDeps = defaultDeps(),
): Promise<GroupedSearchResults> {
  const provider = opts.provider ?? "ollama-nomic";
  const k = opts.k ?? 8;
  const dims = dimensionsFor(provider);
  const slug = projectSlug(projectId);

  const embedder = deps.getEmbedder(provider, opts.ollamaHost);
  await embedder.ensureReady();
  const { vector } = await embedder.embed(query);

  const project = await deps.db.findProjectRepos(projectId);
  if (!project) throw new Error(`Project ${projectId} not found`);

  const projectRepoIds = new Set(project.repositories.map((r) => r.id));
  const repoKeys = project.repositories.map((r) => repoKeyFor(r));

  // Open all stores in parallel and run searches.
  const projectDataPromise = (async () => {
    const store = await deps.openStore("project-data", slug, dims);
    return store.search(vector, k, { sourceTypes: opts.sourceTypes });
  })();

  const convPromise = (async () => {
    const store = await deps.openStore("conversations", slug, dims);
    return store.search(vector, k, { sourceTypes: opts.sourceTypes });
  })();

  const reposPromise = Promise.all(
    repoKeys.map(async (key, idx) => {
      const repo = project.repositories[idx];
      const store = await deps.openStore("repo", key, dims);
      const hits = await store.search(vector, k, { sourceTypes: opts.sourceTypes });
      // Re-attach repoId from current project to hits (vector store may serve multiple projects).
      return attachRepoId(hits, repo.id);
    }),
  );

  const [projectDataHits, convHits, repoHitsArray] = await Promise.all([
    projectDataPromise,
    convPromise,
    reposPromise,
  ]);

  const repoHitsFlat = filterRepoHits(repoHitsArray.flat(), {
    repoIds: opts.repoIds,
    projectRepoIds,
  });

  return {
    projectData: rankAndSlice(projectDataHits, "project-data", k),
    conversations: rankAndSlice(convHits, "conversations", k),
    repos: rankAndSlice(repoHitsFlat, "repo", k),
  };
}

// --- helpers ---

async function indexSource(args: {
  store: IndexStore;
  embedder: IndexEmbedder;
  db: EmbeddingDeps["db"];
  now: () => number;
  bucket: Bucket;
  indexKey: string;
  projectId: string;
  sourceType: string;
  sourceId: string;
  repoId: string;
  filePath: string;
  text: string;
  chunker?: () => Chunk[];
  provider: string;
  dimensions: number;
  mode: IndexMode;
}): Promise<"embedded" | "skipped" | "empty"> {
  const hash = sha256(args.text);

  const existing = await args.db.findIndexEntry({
    bucket: args.bucket,
    indexKey: args.indexKey,
    sourceType: args.sourceType,
    sourceId: args.sourceId,
  });

  if (
    args.mode === "incremental" &&
    existing &&
    existing.contentHash === hash &&
    existing.provider === args.provider
  ) {
    // Still ensure projectId is recorded for this project (multi-project repo share).
    if (existing.projectId !== args.projectId) {
      await args.db.touchIndexEntry(existing.id, args.projectId);
    }
    return "skipped";
  }

  const chunks = args.chunker ? args.chunker() : chunkPlain(args.text);
  if (!chunks.length) return "empty";

  await args.store.deleteBySource(args.sourceType, args.sourceId);
  const now = args.now();
  const records: ChunkRecord[] = [];
  for (const chunk of chunks) {
    const { vector } = await args.embedder.embed(chunk.text);
    records.push({
      id: `${args.sourceType}:${args.sourceId}:${chunk.chunkIndex}`,
      source_type: args.sourceType,
      source_id: args.sourceId,
      repo_id: args.repoId,
      file_path: args.filePath,
      chunk_index: chunk.chunkIndex,
      start_line: chunk.startLine ?? 0,
      end_line: chunk.endLine ?? 0,
      heading: chunk.heading ?? "",
      text: chunk.text,
      vector,
      updated_at: now,
    });
  }
  await args.store.upsertChunks(records);

  await args.db.upsertIndexEntry({
    bucket: args.bucket,
    indexKey: args.indexKey,
    sourceType: args.sourceType,
    sourceId: args.sourceId,
    projectId: args.projectId,
    contentHash: hash,
    chunkCount: chunks.length,
    provider: args.provider,
    dimensions: args.dimensions,
  });

  return "embedded";
}

function sha256(s: string): string {
  return crypto.createHash("sha256").update(s).digest("hex");
}
