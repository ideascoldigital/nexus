# @nexux/storage — Architecture

> Filesystem storage abstraction (pluggable adapter) + per-project `.claude` context builder.

## Purpose

One storage surface for the rest of the system, plus the machinery that gives each project a native Claude context directory (the local-first "context via `.claude/` folder + symlink" rule).

## Key files

| File | Role |
|---|---|
| `src/adapter.ts` | `StorageAdapter` interface (read/write/delete/exists/stat/list/listDetailed/mkdir/symlink), `FileStat`, `DirEntry` |
| `src/adapters/local.ts` | `LocalFsStorage` over `fs/promises`, rooted at a base dir |
| `src/context-builder.ts` | `ContextBuilder`: creates `<dataDir>/projects/<slug>/.claude`, writes `config.json` / `system.md`, symlinks into the workspace (`buildInitialContext`) |
| `src/index.ts` | `getStorage()` (cached; `local` only — `server` throws), `expandHome()` |

## Context layout & symlink rules

- Slug is `projectId.slice(0, 8)` — context lives at `<dataDir>/projects/<slug>/.claude`, so the on-disk path is derived, never stored.
- `createSymlink` links `<workspacePath>/.claude` → that dir. A stale **symlink** is deleted and recreated; a real directory or file at `.claude` is left untouched with a `console.warn` — it never clobbers a hand-written context, and the caller gets no error.

## Public API

`StorageAdapter`, `FileStat`, `DirEntry`, `LocalFsStorage`, `ContextBuilder`, `BrainConfig`, `getStorage`, `expandHome`.

## Dependencies

Internal: `@nexux/config`. No external runtime deps.

## State

Complete for local mode. Server/remote adapter is an explicit stub — the adapter pattern is the extension point for future backends.
