# @nexux/web — Architecture

> The product: "Nexux — AI Dev Orchestrator". Next.js 16 (App Router, Turbopack) + React 19 + Tailwind v4 + shadcn/ui. Local-first: SQLite via Prisma, Ollama/LanceDB search, no cloud required.

## Layout

```
src/
  app/(dashboard)/    # pages, wrapped in AppShell (persistent sidebar)
  app/api/            # REST route handlers, grouped by domain (see below)
  components/         # by domain: layout, features, projects, stack, definition,
                      #   assistant, terminal, github, gitlab, settings, ui (shadcn)
  services/           # thin fetch layer over /api, typed with @nexux/db types
  lib/                # server-side logic: sandbox-manager, task-manager,
                      #   task-scheduler, dev-console, telegram, workspace,
                      #   stack/* (own ARCHITECTURE.md)
  instrumentation.ts  # Next server-startup hook (see Startup)
  hooks/              # use-mobile, use-toast
  providers/          # React Query provider (staleTime 5s, no refetch-on-focus)
```

## Routes

| Route | Purpose |
|---|---|
| `/` | Dashboard: projects with live state, activity, active sandboxes (server component, direct Prisma) |
| `/projects`, `/projects/new` | List + creation wizard (basics/repos → definition → stack → orchestrate) |
| `/projects/[id]` | Tabs: Overview, Features (kanban), Sandboxes, Terminal |
| `/agents`, `/skills` (+ new/edit) | Agent & skill registries |
| `/conversations` | Global conversation list (cost, model, agent) |
| `/terminal` | Full-screen xterm |
| `/settings` | Credentials (cloud/git/Claude tokens), Telegram, GitHub, models |

## API surface (by domain)

- `projects/[id]/…` — bulk of it: `sandboxes` (dev/health/preview/vscode/password/bootstrap-log), `tasks` (+screenshots), `features`, `roadmap` (generate/apply), `dev-phases`, `document/sections/…/revisions`, `stack` (detect/compose/up/down/status/logs/assistant), `orchestration`, `brain`, `index`, `search`, `skills`, `agents`, `repositories`, `env-vars`, `schedules`, `definer/init`
- `assistant/chat` — 5 flow types: agent / skill / code single-agent, project-definer orchestrator+specialists, stack-assistant tool-calling
- `agents`, `skills` (+sync), `conversations`, `credentials`, `github`, `gitlab` (accounts/projects/groups/epics/resolve/sync/issues — one entry per instance, gitlab.com or self-hosted; import scoped by project, group or epic), `telegram/bot`, `embeddings` (health/install-model), `settings`, `terminal/info`, `health`

## Startup

`src/instrumentation.ts` (`register()`) runs once per server boot in **every** target — `next dev`, `next start`, Docker, the Tauri sidecar — and is skipped on the edge runtime. It is the app's only process-lifecycle hook:

1. **Terminal server in-process** — imports `@nexux/terminal/terminal-server` and calls `startTerminalServer()`. No separate process anymore; opt out with `NEXUX_DISABLE_INPROC_TERMINAL=1` (e.g. when running the standalone one in dev, to avoid a port clash).
2. **`ensureDefaultWorkspace()`** — the seeded default must exist before any scoped query runs.
3. **Telegram poller** (`NEXUX_DISABLE_TELEGRAM=1` to skip) — idles on 30s Settings polls until a bot token is set.
4. **Task scheduler** + **crash recovery** (`NEXUX_DISABLE_SCHEDULER=1` to skip both): `recoverOrphanSandboxes` settles sandboxes whose provision/destroy died with the previous process, then `recoverPendingLaunches` re-attaches supervision to queued launches and `recoverDevQueues` fails orphaned running prompts and resumes queued ones.

Each step is individually try/caught — a failing subsystem logs and the server still boots.

## Workspaces

Lightweight scoping layer in `lib/workspace.ts`, designed so everything predating it keeps working:

- `DEFAULT_WORKSPACE_ID = "ws-default"`; the active one travels in the plain `nexux-workspace` cookie, read via `next/headers` by server components and API routes, set by the sidebar switcher. Unknown or stale ids fall back to the default.
- Settings stay in one key/value table: `scopedSettingKey` prefixes non-default workspaces (`ws:<id>:<key>`) while the default keeps bare keys. `getWorkspaceSetting` falls back to the global key, so a workspace without its own token inherits it rather than breaking.

## Data flow

- **Client:** components → React Query hooks → `services/*` fetch layer → `/api` routes. Prisma types imported end-to-end from `@nexux/db`.
- **Server components** hit Prisma directly (`force-dynamic` where live).
- **Real-time:** xterm over WS to `@nexux/terminal` — the client asks `/api/terminal/info` for the live port rather than hardcoding it (3002 standalone / 3032 Tauri / 3102 native dev); agent stream events typed by `@nexux/core`.
- **Telegram:** long-polling bot singleton in `lib/telegram.ts` (survives hot reload) — per-project routing, task/sandbox notifications, reply-to-control, screenshots, `/tasks` `/sandboxes` commands.
- **Forms:** react-hook-form + zod. **No** Redux/Zustand — React Query + localStorage (assistant chat) only.

## Key subsystems

- **Bots (spec 23):** `lib/bot-manager.ts` (session lifecycle, per-session prompt queue, idle reaper, boot recovery) and `lib/bot-view.ts` (pure shaping + input schema) over `@nexux/sandbox` `bot.ts`. Routes under `/api/bots`. UI: `/bots` → `components/bots/bots-view.tsx` (team rail, chat, live noVNC computer panel), in its own `(bots)` route group so the simple view shows bots only — no AppShell sidebar, header or status bar.
- **Sandbox orchestration:** `lib/sandbox-manager.ts`, `lib/task-manager.ts`, `lib/task-scheduler.ts`, `lib/dev-console.ts` — wraps `@nexux/sandbox` (provision → bootstrap → run agent task → notify). UI: `project-sandboxes`, `dev-console` (continuous agent session w/ prompt queue), `run-on-sandbox-dialog`, `scheduled-tasks-card`.
- **Dual brain:** a project's `brain` (`claude` | `opencode`, per `ProjectBrain`) picks which agent CLI runs delegated work. Callers go through `@nexux/sandbox`'s `runAgentTask(policy.brain, …)` and stay brain-agnostic; only model selection (`claudeModel` vs `openCodeModel`) and sandbox provisioning (`installOpenCode`, auto-on when `brain=opencode`) branch on it.
- **Features kanban:** drag between status columns (native HTML5 DnD), optimistic updates + rollback; Queue column wired to the dev sandbox. Roadmap generator bridges the definition document → DevPhases + Features (propose-then-Apply, nothing persisted without Apply).
- **Stack canvas:** React Flow graph of services → compose via `@nexux/harness` `generateCompose`; detect/up/down/logs; tool-calling stack assistant. Logic in `lib/stack/` — see its [ARCHITECTURE.md](src/lib/stack/ARCHITECTURE.md).
- **Definition:** multi-role chat + phase-driven document with sections/revisions (project-definer agents).
- **Command palette:** ⌘K nav + semantic search via `@nexux/embeddings`.

## Package consumption

`@nexux/db` dominates — Prisma client and types flow end-to-end through routes, server components and services. `config` (paths, ports, data dir) is spread thinly across routes and `lib/`. The rest are localized: `sandbox` in `lib/` (sandbox/task/dev-console managers), `storage` in `lib/stack/*` plus the directory-browsing routes, `embeddings` in the search / index / health routes and assistant services, `harness` in `lib/stack/*` for compose generation, `core` re-exported through `types/index.ts` for stream event types, and `terminal` in `instrumentation.ts` alone.

## Runs as

- Standalone dev: `pnpm dev` → :3000 (terminal :3002, in-process).
- Tauri sidecar: built Next server on :3030 (terminal :3032) — see `apps/native/ARCHITECTURE.md`.
