# Spec: Embeddings and semantic search in Nexux

## Objective

Improve searches within a Project and its associated repos with a **local-first** vector index, without depending on cloud services. Expose search as a **default Tool** available to any brain (Claude, Codex, Ollama, etc.).

## Current state

- `src/lib/embeddings/README.md` — empty placeholder.
- `AGENTS.md` states: *"Embeddings are local (LanceDB) and exposed as a default tool."*
- No deps installed. No schema. No pipeline.
- Main DB = SQLite (`prisma/schema.prisma`).
- Repos live in `Repository.localPath`, project in `Project.workspacePath`.

## Indexing scope

One index per `projectId`. Sources:

1. **Cloned repos** (`Repository.localPath`) — code files + markdown.
2. **ProjectDocument + Sections** — living spec of the project.
3. **Features** (`title` + `description` + `aiRefinement`).
4. **Conversations / Messages** — optional phase 2, only assistants and tool results.
5. **Skills / Tools / Agents** descriptions — so the brain can find the right capability.

Exclude: `node_modules`, `.git`, `dist`, `.next`, binaries, lockfiles. Honor `.gitignore` + `.nexuxignore`.

## Proposed stack

### Vector store: **LanceDB** (aligned with AGENTS.md)
- Embedded, columnar, disk persistence.
- Path: `~/.nexux/projects/<slug>/lancedb/`.
- One table per project: `chunks` with columns `id, source_type, source_id, repo_id, file_path, chunk_index, text, vector, metadata, updated_at`.
- Pro: no server, fast query, filters by column.
- Con: native dep — verify binaries in Bun standalone packaging (see [spec 11](11-bun-distribution.md)).

Evaluated alternatives:
- `sqlite-vec` — reuses the existing SQLite, but less mature for large BLOB vectors.
- Chroma local — requires a separate process, violates single-process local-first.

### Embedder: **Ollama `nomic-embed-text`** (robust default)

- 768 dims, 137M params, ~274MB on disk.
- Context window 8192 tokens — supports large chunks.
- Beats OpenAI `ada-002` and `text-embedding-3-small` on MTEB (long docs).
- Apache 2.0, open weights.
- Endpoint: `POST http://localhost:11434/api/embeddings` body `{ model: "nomic-embed-text", prompt: text }`.

**Requirement**: Ollama installed + model present.

Doctor check when starting a project:
```bash
ollama list | grep nomic-embed-text || ollama pull nomic-embed-text
```

If Ollama is missing → UI suggests installing (link to ollama.com/download). Do not block the app, but do block the search feature.

Optional fallbacks (via `Settings.embedding_provider`):
- `local-minilm`: `@xenova/transformers` `Xenova/all-MiniLM-L6-v2` (384 dims, ~25MB) — fully-offline mode without Ollama.
- `openai-3-small` (1536 dims) — opt-in cloud.
- `openai-3-large` (3072 dims) — opt-in cloud, maximum quality.

Provider is persisted in `Settings.key = "embedding_provider"`. Changing provider invalidates the index (different dim) → re-index with confirmation.

### Chunking
Taking advantage of nomic-embed-text's 8192 context:
- Code: per symbol (function/class) with `tree-sitter` if available, fallback to windows of 80 lines with an overlap of 15.
- Markdown/docs: per heading + windows of 2000 tokens.
- Messages: per full message (truncated to 4k tokens).

## Pipeline

```
project → scanSources() → chunk() → embed() → upsert(LanceDB)
                                              ↑
                                              hash(text) skip if equal
```

`EmbeddingIndex` table in Prisma to track what was indexed and when:

```prisma
model EmbeddingIndex {
  id           String   @id @default(cuid())
  projectId    String
  sourceType   String   // file | document_section | feature | message | skill
  sourceId     String   // path or id
  contentHash  String
  chunkCount   Int
  provider     String   // local-minilm | ollama-nomic | openai-3-small
  dimensions   Int
  indexedAt    DateTime @default(now())

  @@unique([projectId, sourceType, sourceId])
  @@index([projectId])
}
```

LanceDB stores vectors; Prisma stores control metadata (what, when, hash) for incremental diffs.

## Indexing triggers

1. **Manual CLI**: `nexux index <projectId>` — full reindex.
2. **Incremental on-demand**: endpoint `/api/projects/:id/index` with `mode=incremental`.
3. **Watcher** (phase 2): `chokidar` over `workspacePath`, debounce 5s.
4. **Post-commit** (phase 2): git hook that triggers incremental.
5. **Auto on Prisma changes**: hooks in `features.ts` / `projects.ts` to reindex the affected sourceId.

## Exposure as a Tool

Register a default Tool when creating a project:

```ts
{
  name: "search_project",
  provider: "cli",
  type: "command",
  command: "nexux search --project <id> --query <q> --k 8",
  description: "Semantic search over project docs, repos, features and skills",
  schema: { query: "string", k: "number?", source_types: "string[]?" }
}
```

Also a local MCP server in phase 2 for brains that prefer the MCP protocol (`provider=mcp`, endpoint `stdio://nexux-mcp-search`).

## Internal API

```ts
// src/lib/embeddings/index.ts
export async function indexProject(projectId: string, opts?: { mode: 'full' | 'incremental' }): Promise<IndexReport>
export async function searchProject(projectId: string, query: string, opts?: { k?: number; sourceTypes?: SourceType[]; repoIds?: string[] }): Promise<SearchHit[]>
export async function dropProjectIndex(projectId: string): Promise<void>

type SearchHit = {
  sourceType: string
  sourceId: string
  filePath?: string
  snippet: string
  score: number
  metadata: Record<string, unknown>
}
```

REST endpoints:
- `POST /api/projects/:id/index` — kick off (returns job id).
- `GET  /api/projects/:id/index` — status + stats.
- `POST /api/projects/:id/search` — body `{ query, k, sourceTypes, repoIds }`.

## Ranking / re-rank

Phase 1: pure cosine top-k.
Phase 2: hybrid (BM25 over the `text` LanceDB column + vector) + optional re-rank with a local cross-encoder (`Xenova/ms-marco-MiniLM-L-6-v2`).

## Distribution (crosses with [spec 11](11-bun-distribution.md))

- LanceDB has native binaries per architecture — include in `next standalone` or Tauri.
- Ollama: required external dep. Distribution assumes prior installation (ollama.com/download). Document in README.
- `nomic-embed-text` model: 274MB pull on first use, persists in `~/.ollama/models/`.
- `local-minilm` fallback (transformers.js): only if implemented, cache in `~/.nexux/models/`.

## Tasks

- [x] Default embedder: **Ollama `nomic-embed-text`** (decided — robustness over setup friction).
- [ ] Add deps: `@lancedb/lancedb`, `ollama` (official JS client), `ignore` (gitignore parser), `tree-sitter` (optional phase 2). `@xenova/transformers` only if the `local-minilm` fallback is implemented.
- [ ] Doctor check Ollama + auto-pull `nomic-embed-text` on first use.
- [ ] Prisma migration `EmbeddingIndex`.
- [ ] Implement `src/lib/embeddings/`: `chunker.ts`, `embedder.ts`, `store.ts`, `index.ts`, `search.ts`.
- [ ] Endpoints `index` + `search`.
- [ ] Register default Tool `search_project` when creating a project (in `src/services/projects.ts`).
- [ ] CLI `nexux index` / `nexux search` (Bun phase).
- [ ] UI: search bar in the project (results with snippet + jump-to-file).
- [ ] Watcher + post-commit hook (phase 2).
- [ ] Local MCP server (phase 2).

## Open questions

1. Index Conversations history from the start or only if the user enables it? (privacy + size).
2. Encrypt vectors on disk? — local-first, default no; opt-in if `Settings.encrypt_index=true`.
3. Does changing the embeddings provider re-index everything automatically or ask for confirmation? — confirmation, it can be expensive.
