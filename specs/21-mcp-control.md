# Spec 21 — MCP control surface: scoped API tokens, `@nexux/mcp`, `/api/mcp`

Status: **phases 1–4 shipped** (2026-08-13, D-62) — tokens, `@nexux/mcp`, the
`/api/mcp` transport and all eight tools. Answering a blocked run remains out
of scope, for the reason given below.

## Goal

Control Nexux from outside the dashboard: send a task from a local Claude,
launch or power a sandbox, and ask what a run is doing when nothing has
reported back over Telegram. The same surface is what lets other systems hook
into Nexux programmatically, so it is designed as a contract from the start
rather than a private convenience.

Two consequences shape everything below. This is the **first inbound
programmatic write path** into Nexux — Telegram is outbound-only, and the app
has no middleware, no sessions, no auth of any kind today. And one of the
tools **spends real money** (a sandbox launch provisions Civo/AWS). Both are
why tokens are scoped rather than a single shared secret.

## Shape

Tool logic lives in a package; the transport lives in the web app.

```
packages/mcp/
  src/context.ts     # NexuxContext — what a tool is allowed to call
  src/registry.ts    # tool list, scope map, dispatch
  src/tools/*.ts     # one module per domain
apps/web/src/app/api/mcp/route.ts   # transport + auth, injects the real context
```

The package **never imports `@/lib/*` or `@/services/*`**. It declares a
`NexuxContext` interface and the route supplies the implementations, calling
services in-process — no HTTP hop, no second deployment. That seam is the
whole reason for the split: a later stdio binary supplies HTTP-backed
implementations of the same interface and every tool works unchanged, which is
what makes the package publishable on its own.

```ts
export type NexuxContext = {
  listProjects(): Promise<ProjectSummary[]>;
  getActivity(): Promise<Activity>;
  createTask(opts: CreateTaskInput): Promise<TaskSummary>;
  launchSandbox(opts: LaunchInput): Promise<SandboxSummary>;
  // …one method per tool, no Prisma client and no `fetch` in the signature
};
```

Keeping Prisma out of the interface is deliberate: a tool that can reach the
client can reach every table, which would make the scope check advisory rather
than enforced.

## Auth — `ApiToken`

New model, new migration:

```prisma
model ApiToken {
  id         String    @id @default(cuid())
  name       String              // what it is for, shown in Settings
  hash       String    @unique   // sha-256 of the token; the value is never stored
  scopes     Json                // string[] — sqlite has no String[], and Json
                                 // is what every other list column here uses
  lastUsedAt DateTime?
  revokedAt  DateTime?
  createdAt  DateTime  @default(now())
}
```

- The token is shown **once**, at creation, and stored only as a SHA-256 hash.
  A dashboard that can display a token again is a dashboard that leaks every
  token when someone shares a screen.
- Comparison uses `timingSafeEqual`. A bad token gets a bare 401 with no body —
  distinguishing "unknown token" from "wrong scope" tells a prober which half
  they got right.
- `lastUsedAt` is touched on every accepted call, so a token nobody remembers
  issuing is visible as one that is still being used.
- Revocation is a timestamp, not a delete: the row is the record that the token
  existed.

Scopes are checked per tool, in the registry, before the handler runs:

| Scope | Grants |
|---|---|
| `projects:read` | list projects, features, phases |
| `tasks:read` | activity, task status, task logs |
| `tasks:write` | create/queue a task |
| `sandboxes:read` | list sandboxes, health, bootstrap log |
| `sandboxes:write` | launch, pause, resume — **provisions real infra** |

`sandboxes:write` is separate from `tasks:write` precisely so a token handed to
an external system can dispatch work onto machines that already exist without
also being able to spend money on new ones.

## Tools

| Tool | Scope | Backed by |
|---|---|---|
| `nexux_list_projects` | `projects:read` | `prisma.project` |
| `nexux_activity` | `tasks:read` | `getActivity()` (`services/activity.ts`) |
| `nexux_task_status` | `tasks:read` | `SandboxTask` row |
| `nexux_task_logs` | `tasks:read` | task log file, tail-limited |
| `nexux_list_sandboxes` | `sandboxes:read` | sandboxes route logic + `reconcileLocalSandboxStatuses` |
| `nexux_create_task` | `tasks:write` | `createTask()` (`lib/task-manager.ts`) |
| `nexux_launch_sandbox` | `sandboxes:write` | `launchSandbox()` |
| `nexux_sandbox_power` | `sandboxes:write` | `pauseSandbox`/`resumeSandbox` |

`nexux_create_task` calls `createTask` rather than reimplementing dispatch.
That function is already the single point every path converges on (board queue,
Telegram, tasks API, follow-ups resuming a branch — D-59), and it enforces its
own invariants: sandbox exists and belongs to the project, sandbox is
reachable, sandbox is not already busy, follow-ups share the parent's sandbox
and branch. An MCP client inherits all of it for free, and a fifth dispatch
path cannot drift from the other four.

`nexux_activity` is the tool that answers the original motivation — "nothing
reported back, what is happening" — and it already distinguishes the states
that matter: blocked on a question, queued behind another run, running,
finished since last look.

### Deliberately out of scope: answering a blocked run

Reporting a blocked run is in (`nexux_activity` carries `needsInput`).
*Answering* one is not, and the reason is structural rather than effort:
`needsInput` is a **dev-console** concept (`lib/dev-console.ts`), a property of
an interactive session, not of a pipeline task. Delivering an out-of-band
answer into that session is a design problem — session ownership, what happens
when two answers race, what a stale answer means — not a wrapper over an
existing function. It gets its own spec. Until then MCP tells you a run is
waiting and the UI is where you answer it.

## Transport & connection

Streamable HTTP at `POST /api/mcp`, authenticated by bearer token:

```bash
claude mcp add nexux --transport http \
  http://localhost:3000/api/mcp \
  --header "Authorization: Bearer $NEXUX_MCP_TOKEN"
```

The URL is not required to be local. A Nexux host on the tailnet is reached the
same way, with the same token and the same scope check:

```
http://<host>.ts.net:3030/api/mcp
```

Public internet exposure is **not** in this spec: it needs rate limiting, TLS
and a rotation story, none of which the tailnet case requires.

## Delivery phases — all shipped 2026-08-13

1. **`ApiToken` + auth** (shipped). Model, migration `20260813120000_api_tokens`,
   `lib/api-token.ts` (hash, verify, scope check), Settings card under
   Integrations. Nothing else could land safely first.
2. **`packages/mcp`** (shipped). `NexuxContext`, registry, scope enforcement.
   Each tool carries its own scope rather than being looked up in a side table,
   so a new tool cannot be forgotten from a map and silently default either way.
3. **Transport + host context** (shipped). `/api/mcp` on the SDK's
   `webStandardStreamableHttp` — Next speaks Web `Request`/`Response`, and the
   Node transport wants `IncomingMessage`. `lib/mcp-context.ts` supplies the
   implementations.
4. **Write tools** (shipped). `nexux_create_task` calls `createTask` rather than
   reimplementing dispatch, so it inherits the invariants already enforced there
   (D-59) instead of becoming a fifth path that drifts.

The scope list ended up existing twice — the package cannot import the app, and
the app should not import a package to render a checkbox. `api-scopes.test.ts`
asserts the two agree, so they cannot drift into minting tokens for scopes no
tool honours.

## Open questions

- Whether a token should be bindable to a single project, which would make an
  external system's blast radius one project rather than the install.
- Rate limiting is unaddressed. It is not needed on a tailnet and is required
  the day this faces anything else.
