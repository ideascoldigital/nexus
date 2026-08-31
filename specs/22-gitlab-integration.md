# Spec 22 — GitLab integration: multi-instance servers, issue import, feature linking

Status: **shipped** (2026-08-27, D-66) · group and epic scopes added 2026-08-28
(D-67) · boards by pasted URL 2026-08-28 (D-68).

## Goal

Make GitLab a first-class source for Nexux features, on gitlab.com *and* on the
self-hosted instances most teams actually run — without asking for a token they
already gave us.

## The two things that make GitLab different

GitHub and ClickUp each have exactly one API host, so `services/github.ts` and
`services/clickup.ts` hardcode theirs. GitLab does not: `https://gitlab.com` and
`https://gitlab.acme.dev` are the same product with different data, and a team
routinely has an account on both. So:

1. **The instance is data, not a constant.** A GitLab account is a
   `ConnectedAccount` (`providerType: "gitlab"`, `authMode: "pat"`) whose
   `metadata.baseUrl` names the origin every call is built from. Adding a
   second instance is adding a second row.
2. **The token can be one you already saved.** A GitLab `CloudCredential` —
   the token that clones repos and logs in to the registry — needs the same
   `api`/`read_api` scope that reading issues does. `metadata.credentialId`
   points at it; pasting a PAT is the fallback, and lands in `OAuthToken` the
   way GitHub's does. See D-66.

## Data

`GitLabIssue` cache + `FeatureGitLabIssue` join (mirror of
`GitHubIssue`/`FeatureIssue`), migration `20260827120000_gitlab_issues`.

Keyed `@@unique([accountId, projectId, issueIid])` on the **numeric** project
id: GitLab projects keep their id across renames and moves between groups, so a
path key would duplicate every issue the first time a group is reorganized.
`projectPath` rides along as the label the pickers show and is refreshed on
every sync.

## Service (`apps/web/src/services/gitlab.ts`)

| Function | Purpose |
|---|---|
| `normalizeBaseUrl` | user-typed URL → bare origin (scheme added, trailing `/` and `/api/v4` trimmed) |
| `addGitLabAccount` | validate against `/user`, upsert by (instance, username) |
| `getGitLabAuth` | `{baseUrl, token}` — credential first, pasted PAT second |
| `revalidateGitLabAccount` | re-check the token; marks `status: "error"` on failure |
| `listProjectsForAccount` / `getGitLabProject` | membership listing with server-side search; single project by id or path |
| `syncGitLabIssues` | paged fetch → upsert transaction |
| `getLocalGitLabIssues` | cache read (state + title search) |
| `linkGitLabIssueToFeature` / `unlink…` / `getGitLabIssuesForFeature` | provenance |

Auth header is `PRIVATE-TOKEN`, not `Authorization: Bearer` — it is what a
personal access token is documented for, and it also accepts project and group
access tokens, which is what a shared "CI bot" credential usually is.
Pagination follows the `x-next-page` response header (GitLab has no body
cursor), capped at 10 pages per call.

## Routes

| Route | Purpose |
|---|---|
| `GET/POST /api/gitlab/accounts` | list / register a server |
| `DELETE/PATCH /api/gitlab/accounts/[id]` | remove / re-validate |
| `GET /api/gitlab/accounts/[id]/projects?search=` | membership listing (server-side search) |
| `GET /api/gitlab/accounts/[id]/projects?path=` | resolve `group/subgroup/project` directly |
| `POST /api/gitlab/accounts/[id]/sync` | `{projectId, projectPath, state}` → cache upsert |
| `GET /api/gitlab/issues?accountId&projectId&state&search` | cache read |
| `POST /api/projects/[id]/gitlab-import` | reviewed phases+features, one transaction |
| `GET/POST/DELETE .../features/[id]/gitlab-issues` | link/unlink/list |

## UI

- **GitLab Servers** (Settings → Integrations, `gitlab-servers-section.tsx`):
  instance URL + label + token source (saved credential, or paste). The
  token-creation deep link is built from the URL being typed, so a self-hosted
  user is never sent to gitlab.com to mint a token that will not work there.
- **Import → GitLab issues** (kanban header, `gitlab-import-dialog.tsx`):
  server → project cascade, sync button, review tree — phase pre-named after
  the project, per-issue checkbox + editable title, state and mapped-status
  badges.
- **Link GitLab Issues** (feature edit drawer, `gitlab-issue-picker.tsx`).
- `gitlab-shared.tsx` holds the account select, the project combobox, the state
  icon and the label chip. GitHub grew two near-identical copies of its
  account/repo cascade (`github-import-dialog` and `issue-picker`); GitLab has
  one.

The project picker searches on the instance rather than filtering a fetched
page: a company server routinely has more projects than the first pages hold,
so client-side filtering would hide exactly the project being hunted for.
Pasting a full path is the escape hatch when search still misses.

## The three scopes (2026-08-28)

GitLab does not stop at `project → issues`. Work is organised
`group → subgroup → epic → issue`, and an epic is a *group*-level object that
gathers issues from several projects at once. The import dialog therefore has a
scope selector rather than only a project picker:

| Scope | Fetched from | Becomes |
|---|---|---|
| Project | `/projects/:id/issues` | phase named after the project |
| Group | `/groups/:id/issues` (subgroups included) | phase named after the group |
| Epic | `/groups/:id/epics/:iid/issues` | phase named after the **epic**, goal = its description |

Epic is the mapping worth having: an epic already *is* a titled, described body
of work spanning repositories, which is what a `DevPhase` is. Group scope is
what makes the feature usable at all on an instance where several groups
happen to use no epics, and it is the answer to "hundreds of projects, which
one?".

Cache reads are scoped three matching ways — `projectId`, `projectPath`
prefix (`platform/` also catches `platform/infra/tf`, and the trailing slash
keeps a sibling `platform-legacy` out), or the epic's global id.

Facts from the instance this was built against, since each one shaped a
decision:

- Well over a thousand epics under one group (a third of them in descendants),
  so both the project and epic pickers search rather than list.
- An issue fetched from one group belonged to an epic of another — epic
  references cross groups, so the link is stored by GitLab's **global** epic id
  and denormalized onto the issue rather than joined to `GitLabEpic`.
- `/groups/:id/issues` returns no `project` object; the path comes from
  `references.full` (`group/subproject#312`).
- `min_access_level` on `/groups` filters to *direct* memberships and cut the
  visible groups to a tenth — it is deliberately not sent.

## Paste a URL (2026-08-28)

The address bar already names the slice of work. A box at the top of the dialog
takes any GitLab URL, resolves it, syncs it and shows the review tree:

| Pasted | Recognised as |
|---|---|
| `/groups/acme/-/boards/151?milestone_title=X` | that board, narrowed to X |
| `/groups/acme/-/epics/6` | epic &6 |
| `/groups/acme/-/issues?milestone_title=X` | milestone X across the group |
| `/acme/platform/bridge/-/issues/215` | project `acme/platform/bridge` |
| `/acme/dashboard` | ambiguous — asked of the instance (subgroup or project) |

Parsing is pure (`lib/gitlab-url.ts`, 12 tests); only the two things the
instance owns go over the wire — a board's name, milestone and columns, and
whether a bare path is a group or a project. The origin comes back too, so a
URL from another instance is refused instead of silently importing nothing.

### Selecting what to import

The review tree carries a per-issue checkbox, and above it a row of chips:
**all**, **none**, then one chip per board column with its `chosen/total`.
Dozens of issues over eight columns is not a list anyone ticks by hand, and
"everything that is not Done yet" is how people describe the slice they want.
Without a board the chips fall back to Open/Closed. Clicking a partly-selected
chip completes it rather than clearing it — the click means "I want these".

The decisions behind that live in `lib/gitlab-import-review.ts`, not the
component, because the gate that chooses between a prompt and the review tree
shipped broken once: it ignored a resolved URL, so a pasted board rendered
"Pick a project to load its issues." and the entire tree — every checkbox with
it — never appeared. The API had been driven end to end; nobody had looked at
the dialog. Logic deciding whether a list renders belongs where a test reaches
it (D-68).

### Board columns

**A board import keeps the column each issue sits in.** GitLab 18 models board
columns as *work-item statuses* — "To do", "Ready for Dev", "In progress",
"Ready for Review", "Released" — and this is the one place REST cannot help:
`/groups/:id/boards/:id` returns `label: null` for every list and no list type
at all. GraphQL reports them, so board reads (and only board reads) go through
`/api/graphql`.

Each issue's `status.name` is cached on `GitLabIssue.boardStatus` and mapped to
a kanban column by `mapColumnToStatus` — the **same** function the GitHub
Projects import uses, since the two vocabularies are identical in practice.
"Released" was added to its done branch, where it had been falling through to
backlog. The mapping runs server-side and rides along as `suggestedStatus`, so
the dialog does not grow its own copy the way the GitHub one did (D-51).

Against the board that motivated this — dozens of issues over ten projects:

```
Ready for Dev     -> todo         Done         -> done
Ready for Review  -> in_review    In progress  -> in_progress
Ready for Design  -> todo         Open         -> backlog
```

## Mapping rules

- project/group → `DevPhase` named after it; epic → `DevPhase` named after the
  epic, with the epic's description as the phase goal. Issue → `Feature`.
- `opened` → `backlog` (checked by default), `closed` → `done` (unchecked).
- Priority is always `medium`: GitLab expresses priority through labels and
  milestones, which are per-project conventions Nexux cannot read reliably.
  Labels and the milestone are shown on the row so the reviewer can retitle
  or reprioritize before importing.

## Known limitations

- Sync is upsert-only; issues deleted in GitLab linger in the cache (same as
  GitHub and ClickUp).
- One scope per import round (repeat for more).
- Group sync stops at 1000 issues (10 pages × 100) and says so in the toast;
  narrow to a subgroup or a project.
- The epic picker reads the cache, so its list is as fresh as the last sync —
  unlike the project and group pickers, which are live. That is the same
  sync-then-review rhythm the issue list already has.
- Nested epics are cached (`parentId`) but the picker is flat; importing a
  parent epic does not pull its children's issues.
- Requires GitLab Premium/Ultimate for the epic scope. On a Free instance
  `/groups/:id/epics` 403s and the epic picker stays empty; project and group
  scopes are unaffected.
- Read-only: nothing is written back to GitLab. Closing an issue when its
  feature reaches `done` is the same deferred write-back ClickUp's spec 20
  step 3 describes, and would want the same policy decision first.
- Issue **types** (`issue`/`incident`/`test_case`/`task`) are imported alike;
  the cache does not record which.
