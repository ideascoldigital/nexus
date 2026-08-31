# @nexux/embeddings — Architecture

> Local semantic search: Ollama (`nomic-embed-text`) + LanceDB. No cloud. Largest single module in `packages/`.

## Purpose

Embed project repos, documents, features, skills and conversation messages into per-project LanceDB indexes and search across them. Exposed to brains as the `search_project` default tool.

## Pipeline

```
scanRepo (fs walk, .gitignore/.nexuxignore aware)
  → chunker (code: line windows w/ overlap · markdown: by heading · plain)
  → Embedder (Ollama nomic-embed-text, context-overflow retry by halving)
  → VectorStore (LanceDB `chunks` tables under <dataDir>/indexes/<bucket>/<safeKey>/lancedb)
```

Incremental indexing: content hashes tracked in the `EmbeddingIndex` Prisma model — unchanged files skipped.

## On-disk layout & repo sharing

`bucketDir(bucket, key)` → `<dataDir>/indexes/<dir>/<safeKey>/lancedb`, where `safeKey` is the key with non-`[A-Za-z0-9_-]` chars replaced by `_`. Bucket-to-dir mapping is not 1:1 — the `repo` bucket maps to **`repos/`** (`store.ts:45-51`); `conversations` and `project-data` map to their own names.

Repo keys are derived from the repository identity (normalised remote URL, else resolved local path), **not** from the project. Consequence: **repo vector stores are shared across projects** that reference the same repository. Two things follow, both deliberate:

- `dropProjectIndex` drops the project-data and conversations stores but only deletes this project's `EmbeddingIndex` tracking rows — the repo store is left intact because another project may still be using it (`index.ts:315`).
- `searchProject` re-attaches the *current* project's `repoId` onto hits returned from a shared store (`index.ts:385`).

## Key files

| File | Role |
|---|---|
| `src/embedder.ts` | `Embedder` over Ollama: `ensureReady()` (pulls model), `embed()`, health check. Only `ollama-nomic` implemented; other providers throw |
| `src/store.ts` | `VectorStore` over LanceDB: upsert/delete/search/dropAll, `bucketDir()` path derivation, self-healing on corruption |
| `src/chunker.ts` | `chunkCode` / `chunkMarkdown` / `chunkPlain`, caps tuned to 8192-token context |
| `src/scan.ts` | `scanRepo` walk with hard-excludes + text-extension/size filters |
| `src/index.ts` | Orchestration: `indexProject` (three buckets: repo / conversations / project-data), `searchProject` (parallel bucket search, grouped), `dropProjectIndex` |
| `src/register-tool.ts` | Upserts the `search_project` Tool row into the DB |

## Public API

`indexProject`, `searchProject`, `dropProjectIndex`, `IndexReport`, `SearchHit`, `GroupedSearchResults`; subpaths for `embedder`, `store`, `chunker`, `scan`, `register-tool`.

## Dependencies

Internal: `@nexux/config`, `@nexux/db` (only package depending on `db`). External: `@lancedb/lancedb`, `ollama`, `ignore`.

## State

Complete and substantial. Default provider is **Ollama nomic-embed-text** (not MiniLM); non-Ollama providers are declared-but-stubbed. See `specs/12-embeddings-search.md`.
