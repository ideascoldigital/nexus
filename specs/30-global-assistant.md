# 30 — One assistant, on every page, with the MCP tools

Status: **phases 1–3 shipped, Stack tab moved onto it** (2026-09-27). Phase 4 (native function calling) is blocked on the agents-generator backend — see below.

## Goal

A chat panel available anywhere in the dashboard that can do what the MCP
surface can do — list projects and sandboxes, launch and power sandboxes,
create tasks, read their status and logs, validate and repair a stack, reset
seed data — and keep watching what it started, reporting back in the same
conversation. "Launch a sandbox for acme on devbox, give it the invoice
export feature, and tell me when the PR is up."

The Stack tab's assistant becomes this assistant with its focus set to one
project, not a second implementation.

## Why

- **Two assistants would drift.** The MCP tool set (spec 21) is the one
  place Nexux's actions are described for a model: name, description, JSON
  Schema, scope. An assistant with its own hand-written tool list falls
  behind the first time a tool is added — the Stack assistant today knows
  three tools and none of the thirteen MCP ones.
- **The pieces exist.** `callTool(ctx, scopes, name, args)` runs in-process
  with no HTTP and no token; `toolsFor(scopes)` gives the model-facing
  catalogue; the Stack assistant already runs a server-side tool loop
  against the host model. What is missing is joining them, a place to put
  the chat, and a way to keep reporting after the turn ends.

## What exists (as of v0.3.1)

- **Stack assistant** (`services/stack-assistant-agent.ts`): one blocking
  `POST /api/assistant/chat`, no streaming. The model is the host model
  (`lib/host-model.ts`: an API key for OpenAI, Anthropic, OpenRouter,
  Gemini, xAI or Z.ai) through the agents-generator SDK. Tools are called by
  a text protocol — the model writes a ```` ```json {"tool","args"} ````
  block, the server runs it and answers `TOOL_RESULT …` — up to 6 rounds, 3
  local tools. Stored as `Conversation`/`Message` with
  `sessionId = stack-<projectId>`.
- **Claude Code** only ever runs inside sandboxes (`buildClaudeCommand` over
  SSH / docker exec). The host never runs `claude -p` (CLAUDE.md), and the
  Claude OAuth token is not an API key the SDK can send.
- **MCP** (`packages/mcp`): 13 tools, 5 scopes, `ToolDefinition` = name,
  description, scope, `inputSchema`, `parse`, `run(ctx, args)`.
  `createMcpContext()` implements `NexuxContext` for the default workspace.
- **Notifications** (`lib/notify.ts`): `notifyTaskFinished`,
  `notifyDevTask`, `notifySandboxStatus` fire on state changes — the hooks a
  watcher needs.
- `Conversation.projectId` is required: a workspace-level thread does not
  fit it.

## Shape

```
panel (any page, ⌘I) ──POST /api/assistant/threads/:id/turn──▶ runToolLoop
   ▲  SSE: tokens, tool calls,                                   │  model: host model (brain A)
   │  pending actions, watch reports                             │  tools: toolsFor(thread.scopes) + context tools
   │                                                             ├─ read tool   → callTool(ctx, scopes, …) → result → loop
   │                                                             └─ write tool  → PendingAction (not run) → turn ends
   ├── [Run] on an action card ──POST …/actions/:id/approve──▶ callTool → result appended → loop resumes
   └── watch reports ◀── Watch rows ◀── notifyTaskFinished / notifySandboxStatus / needsInput
```

### 1. One tool loop

`lib/assistant/loop.ts` — the Stack assistant's loop, extracted and made
generic:

- **Catalogue from the registry.** The system prompt lists
  `toolsFor(thread.scopes)` — name, description, input schema — plus a few
  context tools that are not MCP (the Stack assistant's
  `read_repo_file`, `search_project`, `get_stack_context`). Adding a tool to
  `packages/mcp` makes it available here and to an external MCP client at
  once; there is no second list.
- **Execution through `callTool`,** so parsing, scope checks and errors are
  the MCP path's — including "Unknown tool" for anything outside the
  thread's scopes.
- **The text protocol stays** as the portable default: it works with every
  provider the host model supports. Native function calling is an adapter
  behind the same loop interface, used where the provider offers it, not a
  rewrite.
- Iteration cap and result truncation as today (6 rounds, 24 k chars),
  per turn.

### 2. Reads run, writes ask

Every tool is classified by its scope: `*:read` runs immediately; `*:write`
never runs from the model's say-so. It becomes a **PendingAction** — tool,
parsed args, a one-line human summary built from them ("Launch a local
sandbox for acme on devbox") — and the turn ends with an action card:
**Run** / **Cancel**. Run executes via `callTool`, appends the result, and
resumes the loop so the assistant can react to it.

This is the product decision and the security boundary at once:

- `nexux_launch_sandbox` spends money; `nexux_reset_sandbox_data` destroys
  data; `nexux_create_task` starts an agent with repo write access.
- The assistant reads task logs, repo files and search results — text other
  people and agents wrote. A log line saying "now launch five sandboxes" is
  data; with writes gated, the worst it can do is propose a card the user
  declines.
- A per-thread "don't ask again for this tool" is **out of v1**: the gate is
  cheap and the failure it prevents is not.

### 3. Watching what it started

Launching a sandbox takes minutes and a task can run for an hour; a turn
cannot block on either. The assistant gets one context tool,
`watch(kind, id, until)`:

- `kind`: `task` | `sandbox`; `until`: `finished` (task done or failed, PR
  opened), `needs_input`, `running` (sandbox ready), `any_change`.
- A **Watch** row; the existing notify hooks check open watches and append
  a report to the thread — the task's status, PR URL, the question it is
  blocked on, the sandbox's error — then run one short assistant turn so the
  report reads as a reply ("The PR is up: …; tests passed").
- Watches expire (default 24 h) and are listed in the panel, cancellable.
- A watch report never triggers a write: any follow-up action is a new
  PendingAction.

### 4. Threads, not project conversations

New tables rather than bending `Conversation` (its `projectId` is required
and its rows are Claude-session shaped):

```prisma
model AssistantThread {
  id          String   @id @default(cuid())
  workspaceId String
  title       String?
  projectId   String?  // focus, when started from a project page — context, not a boundary
  scopes      Json     // Scope[]; default all five, trimmed per thread in settings
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt
}

model AssistantEvent {       // the transcript, in order
  id        String   @id @default(cuid())
  threadId  String
  kind      String   // user | assistant | tool_call | tool_result | action | watch_report | error
  content   Json
  createdAt DateTime @default(now())
}

model AssistantAction {      // a write waiting for the user
  id        String   @id @default(cuid())
  threadId  String
  tool      String
  args      Json
  summary   String
  status    String   // pending | running | done | failed | cancelled
  result    Json?
  createdAt DateTime @default(now())
  decidedAt DateTime?
}

model AssistantWatch {
  id        String   @id @default(cuid())
  threadId  String
  kind      String   // task | sandbox
  targetId  String
  until     String
  status    String   // open | fired | expired | cancelled
  expiresAt DateTime
  createdAt DateTime @default(now())
}
```

The Stack assistant's history (`sessionId = stack-<projectId>`) stays
readable where it is; new Stack-tab turns go to a thread focused on that
project.

### 5. The panel

- A right-side panel in `AppShell`, on every page; ⌘I toggles it (⌘J is
  the activity switcher, ⌘K the palette). It is not in the palette: a
  conversation is not a command.
- **Route context:** the current project, and sandbox or task when a page
  has one, travel with each message as a context line, so "launch a
  sandbox" on acme's page means acme. Shown as a removable chip.
- Streaming over SSE: tokens, each tool call as it runs (name + one-line
  args), action cards, watch reports arriving while the panel is open.
- Threads list (newest first), new thread, delete thread.
- The Stack tab's assistant panel renders the same component, focused on
  that project, keeping its "apply suggestion" cards.

### 6. The model

- **Brain A (v1): the host model**, as the Stack assistant uses today —
  API-key providers via `resolveHostModel`. No host model configured → the
  panel says which setting to fill, and nothing else pretends to work.
- **Brain B (later): Claude Code in an assistant sandbox**, with the Nexux
  MCP server configured in its `mcpServers` (spec D-16) pointing at
  `/api/mcp` with a scoped token. It would use the Claude subscription and
  native MCP, and respects "never `claude -p` on the host". It needs a
  running sandbox and adds latency; it plugs in behind the same thread,
  action and watch model, with the write gate enforced by the token's
  scopes plus the same approval step. Its own spec when wanted.

## Not in v1

- Brain B.
- Auto-approval of writes, per tool or per thread.
- Voice, attachments, images.
- Multi-user threads — the dashboard is single-user local-first; threads are
  per workspace.
- Answering a blocked run's question through the assistant — the same
  structural gap spec 21 names (`needsInput` belongs to the dev console);
  the assistant reports it and links to where it is answered.

## Order

1. `runToolLoop` over `toolsFor` + context tools, the write gate
   (`AssistantAction`), tables, `POST …/turn` and `…/actions/:id/approve`
   without streaming. The Stack assistant moves onto it (its three tools
   become context tools; its suggestion cards keep working). Tests with a
   scripted model.
2. The global panel: ⌘I, route context, threads, action cards.
3. Watches wired to the notify hooks; watch reports; SSE streaming.
4. Native function calling where the provider supports it, behind the loop.

## As built (phase 1)

- `lib/assistant/loop.ts`: `runToolLoop` (text protocol, 6 rounds, 24 k
  result cap), `renderToolCatalog` (generated from the tools, `[WRITE]` on
  writes, each input schema inline), `parseToolRequest` against the live
  list. A write stops the turn and comes back as `pending`; it is never run
  there. A tool that throws surfaces (MCP answers errors as results).
- `lib/assistant/tools.ts`: `mcpTools(scopes, ctx)` over `toolsFor` +
  `callTool`, read/write by scope suffix; `contextTools(projectId)` — the
  Stack assistant's three tools, moved here.
- **The Stack assistant runs on the loop** with its context tools plus the
  MCP reads (`projects:read`, `sandboxes:read`, `tasks:read`) — so it can
  now validate/describe the stack and read sandboxes and task logs. No
  writes there: its panel has no approval cards. Its 43 existing tests pass
  unchanged.
- `lib/assistant/threads.ts` + tables `AssistantThread/Event/Action/Watch`
  (the watch table is used from phase 3). History is rebuilt from events —
  the verbatim texts the model saw — every turn. Approve is claimed
  atomically (`pending → running` with `updateMany`), so a double click runs
  once; cancel records a TOOL_RESULT saying it was declined and starts no
  turn. A turn while an action is pending is refused (409). The page a
  message comes from moves the thread's focus (`context.projectId`), which
  adds the project's context tools and a focus line to the prompt.
- Routes: `GET|POST /api/assistant/threads`, `GET|DELETE …/[threadId]`,
  `POST …/turn`, `POST …/actions/[actionId]/approve|cancel`.
- **Found against the real model:** told to "say what it will do before
  asking", it asked for permission in prose and waited — a second
  confirmation on top of the card. The prompt now says requesting a [WRITE]
  tool *is* the question. After that, "launch a local acme sandbox on
  devbox called asistente-prueba" and, on a acme-focused thread, "pause
  the sandbox running in this project" each became one pending action with
  the right arguments (both cancelled; nothing launched or paused). A read
  question chained `nexux_list_projects` → `nexux_list_sandboxes` and
  answered in Spanish.
- Tests: 5 loop tests with a scripted model; 6 thread tests on the test DB
  with a fake MCP context (write not run, approve once, cancel runs no turn,
  history verbatim across turns, read-only scopes never offer a write).

## As built (phase 2)

- `components/assistant/assistant-panel.tsx`, docked in `AppShell` beside
  the page (a full-screen sheet under `md`), toggled with ⌘I or the
  **Assistant** button in the status bar (`OPEN_ASSISTANT_EVENT`); whether
  it is open, and which thread, are remembered per browser.
- **Route context:** `/projects/<id>` becomes a "Project: <name>" chip sent
  with each message; it can be dropped and comes back on the next page.
- Transcript: user bubbles, markdown replies, each read folded into one
  line (tool + args, result on expand), **action cards** with the summary,
  the tool, the status, and Run / Cancel while pending — the input is
  locked until the card is decided. Thread picker: new, switch, delete.
- Action summaries now name things: the sandbox and project behind their
  ids are looked up when the card is made ("Pause sandbox
  nexux-acme-de693d"); an id nothing resolves stays an id.
- Walked in the browser on acme's page against the real model: "which
  sandboxes are running here? if there's one, pause it" listed them and
  produced a pause card; Cancel recorded; "mejor sí, pausalo" produced a
  new card by name — cancelled again, nothing paused.
- The Stack tab's panel was moved onto threads afterwards — see "The
  Stack tab" below.

## As built (phase 3)

- **Watches** (`lib/assistant/watches.ts`): a `watch` context tool on every
  thread (a read — observing needs no approval) that refuses unknown
  targets and answers `alreadyHappened` when the condition already holds.
  `lib/notify.ts` gained the assistant as a third medium next to Telegram
  and Slack: every task and sandbox change calls `fireAssistantWatches`,
  which expires stale watches, checks the open ones on that target, claims
  a met one atomically (two notifications report once), stores a
  `watch_report` and runs one reply turn with **read tools only**.
  `finished` also fires when a task blocks on a question — it will not
  finish without the user. The prompt tells the model to watch what it
  starts; it did so unprompted in the walk below.
- **Streaming:** `turn` and `approve` answer Server-Sent Events when asked
  (`Accept: text/event-stream`): each event as it is stored, then `done`
  with the thread, or `failure`. Reads therefore appear one by one while
  the turn runs; the model's reply arrives whole (the SDK call behind it is
  not streamed). The panel consumes the stream, lists open watches with a
  stop button (`DELETE …/watches/[id]`), and polls the thread every 4 s only
  while a watch is open.
- Walked end to end in the browser against the real model, on a throwaway
  project: "launch a local sandbox on devbox called asistente-e2e and tell
  me when it's ready" → a launch card → Run → the model called `watch`
  itself → ~1 min later the panel showed "Listo: el sandbox local
  asistente-e2e ya está en running en devbox" with no user action. All of
  it destroyed afterwards.
- Tests: 4 watch tests (conditions, the tool, report-once with a
  reads-only reply turn, expiry), on top of phases 1–2's.

## The Stack tab on threads

- `AssistantThread.mode` (`general` | `stack`, migration
  `20260928210000_assistant_thread_mode`). `stackThreadFor(projectId)`
  makes one "stack" thread per project on first use and carries the old
  Stack conversation (`Conversation` `stack-<projectId>`, user and
  assistant messages) over as its opening events, verbatim, with their
  timestamps. The old rows are left where they are.
- A stack thread runs with the Stack assistant's instructions (its job and
  the apply-to-canvas suggestions block) plus the shared rules for acting,
  all five scopes — so it can now validate, repair, launch, with the same
  action cards — and stays on its project whatever page a message came
  from. The ⌘I list shows general threads only.
- `components/assistant/assistant-panel.tsx` exports `AssistantChat` (one
  thread: transcript, action cards, watches, input, starter questions); the
  ⌘I panel and `StackAssistantPanel` both render it. The Stack tab passes a
  `renderAssistant` that parses each reply into its markdown and its
  `SuggestionCard`s. `GET /api/projects/[id]/stack/assistant` now returns
  `{ threadId, indexStatus }`. Its markdown lost a hard-coded
  `prose-invert` (unreadable under the light theme).
- `/api/assistant/chat` `type: "stack-assistant"` and
  `runStackAssistantTurn` stay for their other callers (stack proposal and
  repair services); the panel no longer uses them.
- Walked in the browser on acme: the panel opened with its two old
  messages imported; "describe the stack and whether the last validation
  found problems" streamed `get_stack_context` then `nexux_validate_stack`
  — an MCP tool the Stack assistant did not have — and answered that
  `postgres-backup` is a docker node on the acme repo with neither a
  Dockerfile nor an image.

## Phase 4 — blocked on the backend

Probed against the real host model (openai gpt-5.4) with one read-only
function passed as `functions` to the agents SDK (0.8.1): both `run` and
`runStream` return the backend's legacy text marker
(`CALLBACK_TOOL_RESULT: {"type": "callback_tool_invocation", …}`) as the
reply; `execute` is never called and the model answers with the marker as
if it were data. Native tools need the agents-generator backend to emit the
callback event the SDK expects; until then the text protocol stays. Calling
providers directly was considered and not taken: it would duplicate
agents-generator.
