# Embeddings

Local-first semantic search for Nexux projects.

- **Vector store**: LanceDB embebido en `~/.nexux/projects/<slug>/lancedb/`.
- **Embedder default**: Ollama `nomic-embed-text` (768 dims, 8k context).
- **Control**: Prisma `EmbeddingIndex` para hashes + diffs incrementales.
- **Tool default**: `search_project` registrado al crear proyecto.

Ver `specs/12-embeddings-search.md` para diseño completo.

## Pre-requisitos

```bash
# Instalar Ollama (ollama.com/download), luego:
ollama pull nomic-embed-text
```

## API

```ts
import { indexProject, searchProject, dropProjectIndex } from "@/lib/embeddings";

await indexProject(projectId, { mode: "incremental" });
const hits = await searchProject(projectId, "auth middleware", { k: 8 });
```

## HTTP

- `POST /api/projects/:id/index` `{ mode: "full"|"incremental" }`
- `GET  /api/projects/:id/index` — stats
- `DELETE /api/projects/:id/index` — drop
- `POST /api/projects/:id/search` `{ query, k?, sourceTypes?, repoIds? }`

## Pendiente

- Watcher + post-commit hooks (fase 2)
- MCP server local (fase 2)
- Hybrid BM25 + vector (fase 2)
- GC de filas `EmbeddingIndex` huérfanas
