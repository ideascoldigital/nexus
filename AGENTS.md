# Nexux — Agent Guide

Local-first AI dev orchestrator. Monorepo pnpm + Turborepo: Next.js 16 dashboard (`apps/web`), Tauri shell (`apps/native`), nine `@nexux/*` packages. Read [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the map; each module has its own `ARCHITECTURE.md` next to its code.

## Hard rules (local-first)

- **Never** use `claude -p` or any automated/headless Claude CLI invocation **on the host**. All host Claude usage is manual, interactive (`claude code`). The sanctioned exception: `runClaudeTask` in `@nexux/sandbox` runs `claude -p` *inside* a provisioned sandbox VM/container, launched from the UI.
- Claude context is provided natively via the `.claude/` folder + symlink (built by `@nexux/storage` `ContextBuilder`) — do not build custom context-injection machinery.
- Skills, Tools and MCPs are defined in **neutral format** and adapted per brain (Claude, Codex, xAI, Ollama…). Host-side automation is reserved for non-Claude brains.
- Embeddings are local: Ollama `nomic-embed-text` + LanceDB, exposed as the `search_project` default tool. No cloud embedding providers.
- No multi-tenant, no Firebase, no mandatory cloud. Civo/AWS, Telegram, GitHub are optional integrations.

<!-- BEGIN:nextjs-agent-rules -->
## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

## Commands

```bash
pnpm dev            # web dashboard → :3333 (terminal WS :3002)
pnpm dev:native     # Tauri dev (web on :3100, no sidecar)
pnpm build          # turbo build all
pnpm build:native   # tauri:build → build-app.ts (bundles web as Node sidecar)
pnpm test           # turbo test (packages use `tsx --test`)
pnpm typecheck      # tsc --noEmit everywhere (depends on ^build)
pnpm lint
pnpm db:migrate     # prisma migrations (@nexux/web filter)
```

Run a single package's tests: `pnpm --filter @nexux/<pkg> test`.

## Repo map

| Path | What | Doc |
|---|---|---|
| `apps/web` | The product: dashboard, ~80 API routes, sandbox/task orchestration, Telegram | [ARCHITECTURE.md](apps/web/ARCHITECTURE.md) |
| `apps/native` | Tauri v2 shell, web app as Node sidecar (ephemeral port) | [ARCHITECTURE.md](apps/native/ARCHITECTURE.md) |
| `packages/config` | Env/mode config — dep-graph root | [ARCHITECTURE.md](packages/config/ARCHITECTURE.md) |
| `packages/core` | Shared types only (Claude stream, WS protocol, enums) | [ARCHITECTURE.md](packages/core/ARCHITECTURE.md) |
| `packages/db` | Prisma + SQLite, ~34 models | [ARCHITECTURE.md](packages/db/ARCHITECTURE.md) |
| `packages/embeddings` | Ollama + LanceDB semantic search | [ARCHITECTURE.md](packages/embeddings/ARCHITECTURE.md) |
| `packages/harness` | Brain-facing locked-down Docker exec | [ARCHITECTURE.md](packages/harness/ARCHITECTURE.md) |
| `packages/llm` | Non-Claude LLM clients (Codex) | [ARCHITECTURE.md](packages/llm/ARCHITECTURE.md) |
| `packages/sandbox` | Terraform Civo/AWS VMs + local DinD, runs Claude Code | [ARCHITECTURE.md](packages/sandbox/ARCHITECTURE.md) |
| `packages/storage` | FS adapter + `.claude` context builder | [ARCHITECTURE.md](packages/storage/ARCHITECTURE.md) |
| `packages/terminal` | Human WS terminal (node-pty, SSH) | [ARCHITECTURE.md](packages/terminal/ARCHITECTURE.md) |
| `specs/` | Numbered design specs (source of truth for in-flight work) | — |
| `docs/` | Central architecture, progress, decisions, releasing | — |

## Conventions

- **Config:** new env vars go in `packages/config/src/env.ts` as lazy getters — never scattered `process.env` reads.
- **DB:** schema changes = new timestamped migration in `packages/db/prisma/migrations/`; never edit applied ones. Generated client is checked in.
- **Types:** cross-cutting contracts in `@nexux/core`; Prisma types imported end-to-end from `@nexux/db`.
- **Web data flow:** component → React Query hook → `src/services/*` fetch → `/api` route. Server components may hit Prisma directly. No Redux/Zustand.
- **AI writes to DB:** follow the propose/Apply split (see roadmap generator) — generation endpoints propose, a separate Apply endpoint persists in one transaction.
- **Shelling out:** argv arrays, never string-interpolated shells; credentials via env, never disk (see `sandbox`, `harness`).
- **Three exec surfaces, don't mix:** `terminal` = human PTY · `harness` = brain's local locked-down exec · `sandbox` = full remote dev box.

## Housekeeping (do this as you work)

Enforced by hooks in `.claude/settings.json` (see D-19): `DECISIONS.md` + `PROGRESS.md` are loaded into every session automatically, a missing sibling `*.test.ts` is flagged on write, and `git commit` is blocked while `pnpm test` is red (`--no-verify` or `NEXUX_SKIP_TESTS=1` to override).

- Shipped something significant → update [docs/PROGRESS.md](docs/PROGRESS.md) (module table + timeline line).
- Made a non-obvious choice → add an entry to [docs/DECISIONS.md](docs/DECISIONS.md).
- Changed a module's shape/API → touch its `ARCHITECTURE.md`.
- New design work → numbered spec in `specs/`.
