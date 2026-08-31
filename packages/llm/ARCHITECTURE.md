# @nexux/llm — Architecture

> LLM provider integrations. Currently the thinnest package: a single Codex REST client.

## Purpose

House programmatic LLM provider clients. Note the project rule: **Claude is never invoked programmatically** (local-first rules in `AGENTS.md`); automated brains here are non-Claude (Codex, xAI, Ollama…). Actual Claude Code execution on sandboxes lives in `@nexux/sandbox` (`runClaudeTask`), not here.

## Key files

| File | Role |
|---|---|
| `src/providers/codex.ts` | `fetchCodexUserInfo`, `fetchCodexModels`, `testCodexApiKey`, `createCodexCompletion` — Bearer-auth fetch against `config.integrations.codexApiUrl` |
| `src/index.ts` | Re-exports |

Each function takes `apiKey` plus an optional per-call `baseUrl`. The default base URL is read from config **once at module load** (`const DEFAULT_CODEX_BASE_URL = getConfig().integrations.codexApiUrl`), so changing `CODEX_API_URL` after import has no effect — pass `baseUrl` explicitly to override.

## Public API

Codex functions + `CodexConfig` / `CodexUserInfo` / `CodexModel`; subpath `./codex`.

`CodexConfig` (`{ apiKey, baseUrl? }`) is exported but vestigial — nothing in the repo references it, since the functions take loose `apiKey` / `baseUrl` args instead. Either adopt it as the client's config shape or drop it when the provider abstraction lands.

## Dependencies

Internal: `@nexux/config`. No external runtime deps.

## State

Nascent — single provider, no abstraction layer yet. When adding a second provider, introduce a common provider interface here rather than ad-hoc clients elsewhere.
