# Spec 20 — ClickUp integration: OAuth, task import, feature linking

Status: **steps 1–2 shipped** (2026-08-04/05) · step 3 designed, not built.

## Goal

Make ClickUp a first-class source for Nexux features and dev phases: connect
an account in one click, then turn ClickUp tasks into kanban features without
retyping them.

## Step 1 — OAuth connection (shipped, D-49)

- One-time app setup in Settings → Integrations (client id/secret in
  `Settings`, redirect URL shown to copy). After that, connect/reconnect is a
  single click through ClickUp's consent screen.
- `ConnectedAccount` (`providerType: "clickup"`, `authMode: "oauth"`) +
  `OAuthToken`; `OAuthState` as single-use 10-minute CSRF nonce.
- Routes under `/api/clickup/{config,accounts,oauth/start,oauth/callback}`.
  Callback always redirects to Settings; errors surface as a sticky banner in
  the ClickUp card.

## Step 2 — Import & link (shipped, D-50)

Data: `ClickUpTask` cache + `FeatureClickUpTask` join (mirror of
`GitHubIssue`/`FeatureIssue`), migration `20260805170000_clickup_tasks`.

Service (`apps/web/src/services/clickup.ts`): `listSpaces`, `listLists`
(folders flattened with label), `syncTasks` (paged, upsert transaction),
`getLocalTasks`, `linkTaskToFeature`/`unlink`/`getTasksForFeature`.

Routes:

| Route | Purpose |
|---|---|
| `GET /api/clickup/accounts/[id]/teams` | authorized workspaces (live) |
| `GET /api/clickup/accounts/[id]/spaces?teamId=` | spaces of a workspace |
| `GET /api/clickup/accounts/[id]/lists?spaceId=` | foldered + folderless lists |
| `POST /api/clickup/accounts/[id]/sync` | `{teamId, listId}` → cache upsert |
| `GET /api/clickup/tasks?accountId&listId&search&includeClosed` | cache read |
| `POST /api/projects/[id]/clickup-import` | reviewed phases+features, one transaction |
| `GET/POST/DELETE .../features/[id]/clickup-tasks` | link/unlink/list |

UI:

- **Import from ClickUp** (kanban header, `clickup-import-dialog.tsx`):
  account → workspace → space → list cascade, sync button, review tree —
  phase pre-named after the list (checkbox to skip phase creation), per-task
  checkbox + editable title, ClickUp status badge and mapped status badge.
- **Link Tasks** (feature edit drawer, `clickup-task-picker.tsx`): attach
  cached tasks to an existing feature, GitHub-issues style.

Mapping rules:

- list → `DevPhase` (optional), task → `Feature`.
- `statusType`: open→`backlog`, custom→`todo`, done/closed→`done` (closed
  tasks unchecked by default). Priority: urgent/high/low pass through,
  normal→`medium`.
- Workspaces are read live from `/api/clickup/accounts/[id]/teams`, like the
  spaces and lists below them. They originally came from the account's
  `metadata.teams` snapshot; that snapshot is now only a label in the Settings
  card, because one failed `/team` at connect time froze it at `[]` and the
  picker had no way back. See D-54.

## Step 3 — Write-back (deferred)

Candidates, in order of value: close/update the ClickUp task when its feature
reaches `done`; comment the PR URL on the task when a sandbox run finishes.
Needs a write policy decision (which statuses map back, per-list status
names) — not started.

## Known limitations

- Sync is upsert-only; tasks deleted in ClickUp linger in the cache.
- One list per import round (repeat for more lists).
- Multi-account = multiple ClickUp logins; ClickUp reuses the browser
  session, so a second account needs a ClickUp sign-out or private window
  (hinted in the Settings card).
