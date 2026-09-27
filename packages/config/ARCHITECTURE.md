# @nexux/config — Architecture

> Runtime configuration. Leaf of the dependency graph: every other package (except `@nexux/core`) depends on this one, and this one depends on nothing internal.

## Purpose

Resolve the runtime **mode** (`local` | `server`) and expose all environment variables through a single lazily-evaluated, typed config object. Lazy getters mean reading `config.llm` never triggers `required()` checks for unrelated slices.

## Key files

| File | Role |
|---|---|
| `src/mode.ts` | `MODE` derived from `NEXUX_MODE` (`"server"` or else `local`); `isLocal` / `isServer` flags |
| `src/env.ts` | `NexuxConfig` object with lazy getters, grouped into slices: `mode`, `dataDir`, `databaseUrl`, `encryptionKey`, `llm`, `integrations`, `shell` |
| `src/paths.ts` | `homeDir()` — the only sanctioned way to resolve `~` (see below) |
| `src/index.ts` | Re-exports |

## `homeDir()` — a build constraint, not a convenience

Never call `os.homedir()` directly in code that gets bundled into the Next.js server. `@vercel/nft` statically folds `os.homedir()` to a concrete path at build time; when that path is the base of a dynamic lookup it degrades into a `**` glob and nft walks the entire home tree, which fails the native Windows build with `EPERM: scandir` on protected dirs. `homeDir()` reads `process.env.HOME` first — opaque to nft — falling back to `os.homedir()`, so runtime behaviour is identical and no build-time glob is emitted.

## Env vars

| Var | Slice | Required? |
|---|---|---|
| `NEXUX_MODE` | `mode` | optional (default `local`) |
| `NEXUX_DATA_DIR` | `dataDir` | optional (default `~/.nexux`) |
| `DATABASE_URL` | `databaseUrl` | **required** (throws on access) |
| `ENCRYPTION_KEY` | `encryptionKey` | optional |
| `OLLAMA_URL` | `llm` | optional (default `http://localhost:11434`); a saved "Ollama URL" setting overrides it for embeddings |
| `ANTHROPIC_API_KEY` | `llm` | optional |
| `OPENAI_API_KEY` / `OPENAPI_KEY` | `llm` | optional (first wins) |
| `CODEX_API_URL` | `integrations` | optional (default `https://api.codex.com/v1`) |
| `AGENTS_GENERATOR_API_URL` | `integrations` | optional (default `https://api.agentsgenerator.dev`) |
| `SHELL` | `shell` | optional (default `/bin/zsh`) |

## Public API

`MODE`, `isLocal`, `isServer`, `Mode`, `getConfig()`, `NexuxConfig`, `homeDir()`.

## Conventions

- New env vars go in `env.ts` as part of an existing slice or a new lazy-getter slice — never `process.env` reads scattered in other packages.
- `required(name)` throws on access, not import; `optional(name, default)` for everything else.
- Use `homeDir()` instead of `os.homedir()` for any path that ends up bundled.

## State

Complete and stable. Tested (`env.test.ts`). Extend here first when a new package needs configuration — e.g. `specs/13-harness.md` proposes a `harness` slice, which is **not implemented** (no such slice exists in `src/env.ts` today).
