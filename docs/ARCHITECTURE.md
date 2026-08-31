# Nexux — Architecture (central)

> Local-first AI dev orchestrator: projects → definition → roadmap/features → sandboxes running Claude Code, with local semantic search. No multi-tenant, no Firebase, no cloud requirement.

Per-module detail lives in each module's own `ARCHITECTURE.md` (linked below). This file is the map.

## Monorepo

pnpm workspaces + Turborepo. TypeScript everywhere; packages ship raw TS (`main` → `./src`, no build step) consumed via tsx/Next bundling.

```
apps/
  web/        # @nexux/web    — Next.js 16 dashboard: the product
  native/     # @nexux/native — Tauri v2 shell; web app as Node sidecar (:3030)
packages/
  config/     # env/mode config — root of the dep graph
  core/       # shared type contracts (Claude stream, WS protocol, enums)
  db/         # Prisma + SQLite, custom migration runner (client is generated, not checked in)
  embeddings/ # Ollama nomic-embed-text + LanceDB semantic search
  harness/    # brain-facing Docker exec sandbox (locked down, ephemeral)
  llm/        # LLM provider clients (Codex only, nascent)
  sandbox/    # cloud/local dev VMs: Terraform (Civo/AWS) or DinD, runs Claude Code
  storage/    # fs adapter + per-project .claude context builder
  terminal/   # human-facing WS terminal (node-pty, SSH into sandboxes)
specs/        # numbered design specs (11–22)
docs/         # this file, PROGRESS.md, DECISIONS.md
data/         # local SQLite + indexes (gitignored runtime data)
```

## Internal dependency graph

```
config ← db ← embeddings
config ← storage
config ← harness
config ← llm
config ← sandbox
config ← terminal → core
apps/web → all nine packages
apps/native → (bundles built apps/web)
```

No cycles; max depth 2 (`embeddings → db → config`). `apps/web` is the only composition point.

## Runtime topology

```
┌ Tauri shell (native) ──────────────────────────┐
│  webview → Next.js sidecar :3030               │
│            terminal WS     :3032               │
└────────────────────────────────────────────────┘
   standalone dev: Next :3000 / terminal WS :3002

Next.js (apps/web)
 ├─ SQLite (Prisma, data/dashboard.db · native: ~/.nexux/nexux.db)
 ├─ LanceDB + Ollama (semantic search, <dataDir>/indexes)
 ├─ Telegram bot (long-polling singleton, optional)
 ├─ @nexux/terminal WS server (human PTY / SSH into sandbox)
 ├─ @nexux/harness → docker run (locked-down brain exec)
 └─ @nexux/sandbox → Terraform → Civo/AWS VM  ─or─ local DinD container
                      └─ cloud-init bootstrap → claude -p (stream-json) tasks
```

## Core flows

1. **Project creation (wizard):** basics + repos → definition (multi-role definer agents) → stack graph → orchestration (skills/agents). `ContextBuilder` writes `<dataDir>/projects/<slug>/.claude` and symlinks it into the workspace.
2. **Definition → roadmap:** roadmap generator reads definition sections, proposes DevPhases + Features (propose/Apply split — nothing persisted without Apply). Features flow through the kanban; Queue column feeds the dev sandbox.
3. **Task run:** feature → task → `sandbox-manager`/`task-manager` provision (Terraform or local DinD) → cloud-init bootstrap → `runClaudeTask` (`claude -p --output-format stream-json` **on the sandbox**) → progress + result parsed → UI + Telegram notify.
4. **Search:** `indexProject` chunks + embeds repo/conversations/project-data into LanceDB buckets; `search_project` is a default tool for any brain; ⌘K palette uses it too.

## Brains model

Brain-agnostic by design: Skills, Tools, MCPs defined in neutral format, adapted per brain. Claude = **manual only on the host** (interactive `claude code`; context via `.claude/`); automation on the host is for non-Claude brains. Sandboxes are the sanctioned place for automated Claude runs.

Sandbox runs are **dual-brain**: `SandboxBrain = "claude" | "opencode"` (`@nexux/sandbox`), dispatched through `runAgentTask` so callers (`task-manager`, `dev-console`) stay brain-agnostic. See [spec 16](../specs/16-opencode-brain.md).

## Two execution surfaces (don't confuse)

| | `@nexux/harness` | `@nexux/sandbox` |
|---|---|---|
| For | brains (programmatic) | full dev/test box |
| Where | local Docker, `--network none` | Civo/AWS VM or local DinD |
| Lifespan | ephemeral seconds–minutes | provisioned, long-lived |
| Interface | `exec`/`readFile`/`writeFile` structured | SSH, `claude -p`, VS Code Remote |

Plus `@nexux/terminal` = the *human* PTY. Three surfaces, three audiences.

## Module docs

- [apps/web/ARCHITECTURE.md](../apps/web/ARCHITECTURE.md) · [apps/native/ARCHITECTURE.md](../apps/native/ARCHITECTURE.md)
- [config](../packages/config/ARCHITECTURE.md) · [core](../packages/core/ARCHITECTURE.md) · [db](../packages/db/ARCHITECTURE.md) · [embeddings](../packages/embeddings/ARCHITECTURE.md) · [harness](../packages/harness/ARCHITECTURE.md) · [llm](../packages/llm/ARCHITECTURE.md) · [sandbox](../packages/sandbox/ARCHITECTURE.md) · [storage](../packages/storage/ARCHITECTURE.md) · [terminal](../packages/terminal/ARCHITECTURE.md)

## Related

- [PROGRESS.md](./PROGRESS.md) — state & timeline. [DECISIONS.md](./DECISIONS.md) — why things are the way they are. `specs/` — design docs.
