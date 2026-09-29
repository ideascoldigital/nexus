# 18 — Configuration export/import (portable JSON)

## Goal

Move a Nexux install's **configuration** — workspaces, projects, repos, stack
canvas, sandbox config, roadmap, catalogs, schedules, and optionally the
secrets — between instances as a single JSON file. The driving case is
replicating a local (Mac) install onto a 24/7 VM and keeping the two
reconcilable afterwards, but the same artifact is the backup story for a
local-first app whose entire state is one unversioned SQLite file.

Non-goal: **synchronisation**. Nothing here merges concurrent edits or
resolves conflicts. Import is a deliberate, one-directional, user-triggered
operation with a preview. Two-way sync would need per-row versioning the
schema does not have and is out of scope.

Related: research on VM distribution (this spec's origin), D-23 (values
revealed on demand), D-28 (secrets cross the wire only through `reveal`),
`specs/14-sandbox-provisioning.md` (what `Sandbox` rows mean).

## Why not just copy `dashboard.db`

`scp`-ing the SQLite file works today and is the honest fallback. It is
rejected as *the* answer for three reasons:

1. It carries machine state — `Sandbox.instanceId`, `publicIp`, Terraform
   `workDir` — that describes VMs the destination does not control (see
   "Layer 3").
2. It carries absolute host paths (`/Users/dev/...`) that do not exist on
   Linux, with no opportunity to remap.
3. It is all-or-nothing: no way to move one project, and no way to move
   configuration *without* every API key in the file.

The export is the same data minus those three problems, and readable.

## The blocking precondition: secrets are stored in plaintext

`ENCRYPTION_KEY` is read in `packages/config/src/env.ts` and **never
consumed**. There is no `createCipheriv` anywhere in `apps/web/src` or
`packages/` — the only `crypto` uses are `randomUUID` and content hashing in
`@nexux/embeddings`. Yet `Settings.value` is commented *"encrypted API key"*,
`OAuthToken.accessToken` *"encrypted"*, and `.env.docker.example` states the
key *"encrypts stored API keys"*.

So `ProjectEnvVar.value`, `CloudCredential.data`, `Settings.value` and
`OAuthToken.*` are plaintext on disk. Consequences this spec must respect:

- A "complete" export is a file containing every API key in the clear. A file
  travels in ways a database file does not (chat, email, a cloud sync folder),
  so the default must not produce one.
- **`includeSecrets` defaults to `false`.** Layer 1 is the default export.
- When `includeSecrets: true`, the response is not raw JSON — see "Secrets
  envelope". This spec does **not** implement DB-at-rest encryption; that is
  a separate change. It does refuse to make the situation worse.
- The misleading `// encrypted` comments should be corrected in the same PR
  that lands this. They actively mislead anyone reasoning about export safety.

## Three layers

### Layer 1 — portable configuration (the default export)

| Model | Notes |
|---|---|
| `Workspace` | root; `ws-default` exists on every install |
| `Project` | `workspacePath` is a host path → relativised |
| `Repository` | `localPath` host path → relativised; `repoUrl` portable. `cloneStatus` reset to `pending` on import |
| `RepositorySetup` | install/build/run/branch — portable |
| `StackNode`, `StackEdge` | full canvas |
| `SandboxConfig` | FKs to `CloudCredential` → see "Credential shells" |
| `SandboxConfigLlmCredential` | join |
| `Agent`, `Skill`, `Tool` | catalogs |
| `ProjectSkill`, `ProjectAgent`, `AgentSkill` | joins |
| `ProjectBrain` | |
| `Phase`, `DevPhase`, `Feature` | roadmap + kanban |
| `ProjectDocument`, `ProjectDocumentSection` | definition |
| `TaskSchedule` | imported **disabled** — see "Schedules arrive disabled" |
| `CloudCredential` | shell only (`data: null`) unless `includeSecrets` |

`ProjectDocumentRevision` is excluded: revision history is large and its value
is local (undo), not portable.

### Layer 2 — secrets (opt-in)

`ProjectEnvVar.value`, `CloudCredential.data`, `Settings`, `ConnectedAccount`,
`OAuthToken`.

`OAuthToken` is included but flagged: tokens are account- and often
device-scoped, and moving them does not reliably move the session. Import
writes them, the UI reports the account as `pending` until re-checked.

### Layer 3 — never exported (machine state)

- `Sandbox` — `instanceId`, `publicIp`, `workDir` point at infrastructure the
  destination cannot manage. Importing these produces rows whose Destroy
  button targets someone else's VM. Excluded unconditionally, including with
  `includeSecrets`.
- `SandboxProcess` — PIDs and `/tmp` paths on a specific box.
- `SandboxTask` — run logs; historical, high-volume, meaningless without the
  sandbox.
- `EmbeddingIndex` — the rows are bookkeeping for LanceDB tables living at
  `<dataDir>/indexes`, which do not travel in a JSON. A row without its table
  is worse than no row: it makes the destination think a project is indexed.
  The destination re-indexes.
- `OAuthState` — in-flight CSRF nonces.
- `GitHubIssue`, `FeatureIssue` — a cache of a remote system; re-syncable.
- `Conversation`, `Message` — excluded from the default. Optional
  `includeConversations` flag, off by default: high volume, and they are a
  log rather than configuration.

## Artifact shape

One JSON object, nested by project rather than a flat table dump. Nesting is
deliberate: the file is meant to be read by a human before it is imported, and
the import can process one project at a time.

```jsonc
{
  "meta": {
    "nexuxExportVersion": 1,
    "schemaVersion": "20260801120000_sandbox_processes",
    "exportedAt": "2026-08-02T10:00:00.000Z",
    "sourceMode": "local",
    "pathRoot": "/Users/dev/workspace",
    "includesSecrets": false,
    "includesConversations": false,
    "scope": { "kind": "all" }
  },
  "workspaces": [{ "id": "ws-default", "name": "…", "icon": null, "logo": null }],
  "credentials": [
    { "id": "clx…", "workspaceId": "ws-default", "name": "civo-main",
      "provider": "civo", "data": null }
  ],
  "settings": [],
  "catalogs": { "agents": [], "skills": [], "tools": [] },
  "projects": [
    {
      "id": "clx…",
      "workspaceId": "ws-default",
      "name": "Metaphor",
      "workspacePath": { "root": "pathRoot", "rel": "ideascol/metaphor" },
      "repositories": [
        { "id": "clx…", "name": "web", "repoUrl": "git@github.com:…",
          "localPath": { "root": "pathRoot", "rel": "ideascol/metaphor/web" },
          "isMain": true, "setup": { "installCommand": "pnpm install", … } }
      ],
      "stack": { "nodes": [], "edges": [] },
      "sandboxConfig": { "…": "…", "credentialId": "clx…" },
      "envVars": [
        { "id": "clx…", "key": "DATABASE_URL", "repositoryId": null, "value": null }
      ],
      "brain": null,
      "phases": [], "devPhases": [], "features": [],
      "document": { "…": "…", "sections": [] },
      "schedules": [],
      "skills": [], "agents": [], "agentSkills": []
    }
  ]
}
```

### `meta.schemaVersion`

The last row of `_nexux_migrations` (the custom runner in
`packages/db/src/migrate.ts`), not a hand-maintained constant — it is the only
value that is true by construction.

Import compares it to the destination's:

- **equal** → proceed.
- **destination newer** → proceed with a warning. Migrations are additive in
  practice; missing columns take their defaults.
- **destination older** → **refuse**. The file may carry columns that do not
  exist yet, and silently dropping them produces a project that looks imported
  and is not. The error names both versions and says to upgrade first.

`nexuxExportVersion` is the *envelope* version, bumped only when this
document's structure changes. A file from a future envelope version is
refused outright.

### Paths are relative to a declared root

`Project.workspacePath` and `Repository.localPath` are absolute host paths.
`/Users/dev/workspace/x` does not exist on a Linux VM, and D-14 local
sandboxes bind-mount `localPath` — a wrong value there fails at provision
time, not at import time, which is the worst place to discover it.

Export writes `{ root: "pathRoot", rel: "…" }` for any path under
`meta.pathRoot`, and `{ root: "absolute", abs: "/opt/other" }` for paths
outside it (rare, but must not be silently mangled). `pathRoot` is the longest
common prefix of every exported path, or the user's override.

Import takes a `pathRoot` for the destination and rejoins. Paths marked
`absolute` are carried verbatim and **listed in the preview** so the user sees
what will not resolve.

Nothing verifies the resulting directory exists — a config import may
legitimately precede cloning the repos. The preview reports which paths are
missing on disk as information, not as an error.

### Credential shells

`SandboxConfig.credentialId` / `githubCredentialId` / `claudeCredentialId`
and `SandboxConfigLlmCredential.credentialId` are FKs to `CloudCredential`.

Without secrets, exporting the config but not the credential leaves those FKs
dangling. Setting them to null loses the *intent* (which of two Claude tokens
this project pins — exactly the problem D-28 solved).

So a secretless export still emits the credential **shell**: `id`, `name`,
`provider`, `workspaceId`, with `data: null`. Import creates the row if absent
and marks it `needsSecret` in the result, so the UI can list "3 credentials
need their values" and link to Settings. The FKs stay intact, the project is
configured, and the missing piece is named rather than silent.

Same treatment for `ProjectEnvVar`: the row is created with `value: ""` and
reported under `needsValue`. An env var whose key is known and value is not is
strictly better than an absent one — it is a checklist.

### Secrets envelope

With `includeSecrets: true` the endpoint requires a `passphrase` and returns
an **encrypted** file, never raw JSON:

```
{ "nexuxExportVersion": 1, "encrypted": true,
  "kdf": { "name": "scrypt", "N": 16384, "r": 8, "p": 1, "salt": "<b64>" },
  "cipher": "aes-256-gcm", "iv": "<b64>", "tag": "<b64>", "payload": "<b64>" }
```

`scrypt` + `aes-256-gcm` from `node:crypto` — no new dependency. The plaintext
inside is exactly the Layer-1+2 document above. `meta` is **not** duplicated
outside the envelope: version and scope are secrets-adjacent metadata, and an
importer must decrypt before it can decide anything.

This is transport encryption for the file. It does not encrypt the database.
It does mean the artifact is not more exposed than the DB it came from.

### Schedules arrive disabled

`TaskSchedule` rows carry `cron` and `enabled`. Importing them enabled means
an import can, minutes later, provision cloud sandboxes and open PRs on the
destination — while the source instance is still doing the same on its own
timer. Duplicate agents, duplicate PRs, double spend.

Import therefore forces `enabled: false` and clears `lastRunAt` /
`nextRunAt` / `lastTaskId`. The result reports how many arrived disabled. Turning
them on is one deliberate click, and it is the moment to turn them *off* on
the source.

Same reasoning applies to the Telegram bot, which is a long-polling singleton:
two instances configured with the same token fight over updates. The import
preview warns when the destination would end up with a `telegram_*` setting
that the source also has. It does not change the value — that would be
guessing which host should own the bot.

## IDs and idempotency

Every model uses `cuid()`. Two options were considered:

- **Regenerate ids on import** — no collisions, but every FK needs remapping,
  and a second import of an updated file creates duplicates of everything.
- **Preserve ids, upsert by id** — chosen. A re-export/re-import converges
  instead of accumulating. Mac → VM → edit → Mac stays coherent as long as the
  direction is deliberate.

Collisions between unrelated installs are not a practical concern: `cuid()`
values do not repeat across machines. A colliding id therefore means *the same
row*, which is what upsert assumes.

Two import modes:

- **`merge`** (default) — upsert by id. Rows present in the destination and
  absent from the file are left alone. Additive; nothing is destroyed.
- **`replace`** — for the projects in scope, rows absent from the file are
  **deleted**. Makes the destination match the file exactly. Destructive by
  design, gated behind an explicit confirmation naming the counts, and never
  the default.

`replace` never touches Layer 3, catalogs shared with out-of-scope projects,
or credentials referenced by a project outside the import scope.

## Dry run

Modelled directly on `POST …/env-vars/bulk`, which already establishes the
pattern in this codebase: parse server-side, report what is new / overwritten /
ignored, then let the user commit.

`POST /api/import` with `dryRun: true` performs every validation and every
lookup, writes nothing, and returns the plan:

```jsonc
{
  "ok": true,
  "schemaVersion": { "file": "…", "destination": "…", "verdict": "equal" },
  "projects": [
    { "id": "clx…", "name": "Metaphor", "action": "update",
      "counts": { "repositories": { "create": 1, "update": 2 },
                  "features": { "create": 12, "update": 0 },
                  "stackNodes": { "create": 4, "update": 1, "delete": 0 } },
      "paths": [ { "field": "workspacePath", "resolved": "/opt/ws/metaphor",
                   "existsOnDisk": false } ] }
  ],
  "credentials": { "needsSecret": ["civo-main", "gh-dev"] },
  "envVars": { "needsValue": 14 },
  "schedules": { "importedDisabled": 3 },
  "warnings": [ "Destination already has a telegram_bot_token setting" ],
  "errors": []
}
```

The UI renders this before anything is written. A non-empty `errors` makes the
real import refuse with the same payload.

## API

Two routes, mirroring the existing `apps/web/src/app/api` conventions
(zod-validated bodies, `NextResponse.json`, error shapes as in the env-var
routes).

### `GET /api/export`

| Query | Default | Meaning |
|---|---|---|
| `scope` | `all` | `all` \| `project` |
| `projectId` | — | required when `scope=project`, repeatable |
| `includeSecrets` | `false` | requires `passphrase`; returns the encrypted envelope |
| `includeConversations` | `false` | adds `Conversation` + `Message` |
| `pathRoot` | derived | override the computed common prefix |

`passphrase` is a **POST-only** concern: when `includeSecrets=true` the client
must use `POST /api/export` with a JSON body, so the passphrase never lands in
a URL, a server log, or browser history. The `GET` form exists for the
common, secretless case and is what the "Download configuration" button uses.

Response is `application/json` with `Content-Disposition: attachment;
filename="nexux-export-<yyyymmdd-hhmm>.json"` (`.json.enc` when encrypted).

### `POST /api/import`

```jsonc
{ "dryRun": true, "mode": "merge", "pathRoot": "/opt/workspace",
  "passphrase": "…", "data": { /* the export document, or the envelope */ } }
```

`pathRoot` is required when the file contains any `{ root: "pathRoot" }` path
and the destination's own root differs; the dry run reports it as an error
when missing rather than guessing.

Writes are sequential rather than one transaction, matching the reasoning
already recorded in the bulk env-var route: SQLite serialises writes anyway,
and a partial import that reports exactly how far it got is more useful than a
rollback that hides which row was malformed. Ordering respects FK dependencies
— workspaces → credentials → catalogs → projects → repositories → everything
project-scoped.

## Implementation sketch

| File | Role |
|---|---|
| `apps/web/src/lib/export/schema.ts` | zod schema of the export document; the single definition of the envelope, used to validate on both ends |
| `apps/web/src/lib/export/collect.ts` | DB → document. Scope filtering, layer selection, path relativisation, credential shells |
| `apps/web/src/lib/export/apply.ts` | document → DB. Dry-run planner and the writer share one code path, parameterised on `dryRun`, so the plan cannot drift from what runs |
| `apps/web/src/lib/export/paths.ts` | `relativise` / `resolve`, longest-common-prefix |
| `apps/web/src/lib/export/envelope.ts` | scrypt + aes-256-gcm seal/open |
| `apps/web/src/app/api/export/route.ts` | `GET` (secretless) + `POST` (with passphrase) |
| `apps/web/src/app/api/import/route.ts` | `POST`, dry-run and commit |
| `apps/web/src/services/export.ts` | client service, React Query, matching D-11 |

UI: a "Backup & migration" panel in Settings — Export (scope picker, two
toggles, passphrase field revealed by the secrets toggle) and Import (file
drop → dry-run result table → Confirm). Per-project export also offered from
the project menu.

The dry-run planner and the writer being one function is the load-bearing
detail: a preview computed by different code than the write is a preview that
eventually lies.

## Tests

`apps/web/src/app/api/export-routes.test.ts`, following the existing
`env-presets-routes.test.ts` / `env-vars-routes.test.ts` setup:

- Round trip: export → import into an empty DB → export again → **byte-equal**
  documents (modulo `meta.exportedAt`). This is the property that makes the
  format trustworthy.
- Idempotency: importing the same file twice in `merge` produces no second set
  of rows.
- **No plaintext without `includeSecrets`** — assert no `ProjectEnvVar.value`,
  no `CloudCredential.data`, no `Settings.value` appears anywhere in the
  serialised secretless export. Mirrors the assertion D-28 already pins for
  the presets listing.
- Layer 3 exclusion: a DB with sandboxes, processes, tasks and embedding-index
  rows exports none of them, `includeSecrets` on or off.
- Path remap: export under root A, import under root B, assert every
  `workspacePath` / `localPath` rebased; assert `absolute`-marked paths pass
  through untouched and are surfaced in the plan.
- schemaVersion: older destination refuses, newer warns, equal proceeds.
- Schedules land `enabled: false` with cleared run bookkeeping.
- Credential shells: FKs survive a secretless round trip; `needsSecret` names
  the right credentials.
- `replace` deletes only within scope; a credential referenced by an
  out-of-scope project survives.
- Envelope: seal → open round trip; wrong passphrase fails on the GCM tag
  rather than yielding garbage.

## Open questions

1. **Should `includeSecrets` exist at all before the DB is actually
   encrypted?** Arguments both ways: it is the feature that makes the VM
   replica work in one step, and it is a file of API keys. Current answer —
   ship it, encrypted-at-rest in the envelope, off by default. Revisit if
   `ENCRYPTION_KEY` gets a real implementation, at which point the export can
   carry ciphertext straight through without a separate passphrase.
2. **Conversations.** Excluded by default. If the VM is to continue a
   conversation started on the Mac, they must travel — but they are the
   bulk of the data and the least configuration-like. Left as a flag until
   there is a concrete need.
3. **A CLI entry point** (`pnpm nexux:export > file.json`) would make this
   scriptable for scheduled backups without going through the HTTP API. Not
   in scope here; the lib split under `src/lib/export/` is deliberately
   framework-free so a CLI can call `collect`/`apply` directly.

## State

**Export implemented** (2026-08-02, D-31): `src/lib/export/{schema,paths,envelope,collect}.ts`,
`GET`/`POST /api/export`, `src/services/export.ts`, 46 tests across
`export-routes.test.ts`, `paths.test.ts`, `envelope.test.ts`,
`services/export.test.ts`.

**Import implemented** (2026-08-02, D-32): `src/lib/export/apply.ts`,
`POST /api/import`, `previewImport`/`commitImport` in `src/services/export.ts`,
24 tests in `import-routes.test.ts`. Dry run and writer are one function
parameterised on `dryRun`, as specified.

Two things the spec did not anticipate, both now handled:

- **`commonRoot` must be a *strict* ancestor.** A project whose repos live
  inside its own workspace makes that workspace the longest common prefix, so
  its own `rel` became `""` and the project's directory name was erased —
  resolving to the bare destination root on import. Found by the round-trip
  test, fixed in `paths.ts`, regression-tested. This was the normal layout,
  not an edge case.
- **Globally `@unique` catalog names.** `Agent.name` / `Skill.name` collide
  across installs under different ids, where upsert-by-id throws. The
  incumbent wins (its name is what joins and `.claude` context reference) and
  the file's id is remapped onto it for that import's joins. Rows with a
  `@unique` FK (`SandboxConfig.projectId`, `ProjectDocument.projectId`,
  `RepositorySetup.repositoryId`, `Phase(projectId,key)`,
  `ProjectDocumentSection(documentId,key)`) are keyed on that constraint
  rather than the row id, for the same reason.

**UI implemented** (2026-08-02): `src/components/settings/backup-migration.tsx`,
mounted as a "Backup & migration" tab on the Settings page. Export is one
click, with the secrets toggle revealing a passphrase field that gates the
download until it reaches `MIN_PASSPHRASE`. Import is deliberately three
steps — pick a file, **Preview changes** (a dry run), then **Apply** — and
`replace` adds a fourth: a confirm dialog naming the deletion count. The plan
report doubles as the post-import receipt, listing what the import could not
do for the user (credentials needing secrets, env vars arriving empty,
schedules arriving disabled, project folders not yet on disk).

**Spec complete.**
