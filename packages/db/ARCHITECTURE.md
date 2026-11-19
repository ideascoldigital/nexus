# @nexux/db — Architecture

> Prisma-over-SQLite data layer. Singleton client with opt-in auto-migration. Richest schema in the repo (36 models).

## Purpose

Own the persistent data model and expose a single `prisma` client instance plus all generated types.

## Key files

| File | Role |
|---|---|
| `src/client.ts` | Builds `PrismaClient` with the better-sqlite3 adapter; resolves `file:` URL, ensures data dir exists, opt-in auto-migrate, caches on `globalThis` in non-prod. Exports the client **wrapped in the vault extension** (the raw one stays private) and `ensureVault()` for boot |
| `src/vault.ts` | **Vault crypto** (spec 32): AES-256-GCM `sealString`/`openString`/`sealJson`/`openJson` (`nxv1:` / `{"$nxv"}`; plaintext reads through), the key (`NEXUX_VAULT_KEY` → ephemeral for temp-dir DBs → macOS Keychain `nexux-vault` → `vault.key` 0600), `keyCheck` |
| `src/vault-extension.ts` | `SEALED_FIELDS` and `withVault`: seal on create/update/upsert/createMany, open on read (incl. nested `include`/`select`). Nested writes from a parent model bypass it — seal those explicitly |
| `src/vault-admin.ts` | `prepareVault`: key check against `Settings.vault_key_check` (refuses a mismatched key), then seals every plaintext value left — the migration of existing secrets, idempotent |
| `src/migrate.ts` | `ensureMigrated(dbPath, migrationsDir)` — forward-only runner tracked in `_nexux_migrations`, each `migration.sql` applied in a transaction |
| `prisma/schema.prisma` | Source of truth for the schema |
| `src/generated/prisma/**` | The live generated client — **git-ignored**, must be built locally (see Generate step) |

## Generate step (required after clone)

`src/client.ts` imports `./generated/prisma/client`, and `.gitignore` ignores `**/generated/prisma`. The client you actually run is therefore **not** tracked: run `pnpm --filter @nexux/db generate` after cloning or after any schema change, or the package will not resolve.

The rest of `src/generated/**` (`client.ts`, `models/`, `internal/`, …) *is* tracked, but it is a stale May artifact left over from an older generator layout — the `./client` / `./types` subpath exports still point at it. Do not treat it as the current client.

## Connection

`datasource db` declares only `provider = "sqlite"` — no `url`. The connection is supplied at runtime by the better-sqlite3 driver adapter from `config.databaseUrl`, which **must** start with `file:` (`client.ts` throws on any other scheme).

## Data model (domain clusters)

- **Scoping:** `Workspace` — hard isolation boundary owning projects, agent/skill catalogs, credentials and key-prefixed settings; `ws-default` is seeded by migration
- **Project core:** `Project`, `Repository`, `RepositorySetup`, `ProjectEnvVar`, `StackNode`/`StackEdge`
- **Planning:** `Feature`, `DevPhase`, `Phase`, `Plan`, `ProjectDocument`(+`Section`/`Revision`), `GitHubIssue`/`FeatureIssue`, `GitLabIssue`/`FeatureGitLabIssue`
- **Agents & brains:** `Agent`, `Skill`, `ProjectAgent`, `ProjectSkill`, `AgentSkill`, `ProjectBrain`, `Tool`
- **Conversations:** `Conversation`, `Message`
- **Sandboxes:** `Sandbox`, `SandboxConfig`, `SandboxTask`, `TaskSchedule`, `CloudCredential`
- **Integrations:** `ConnectedAccount`, `OAuthToken`, `OAuthState`, `Settings`, `ClickUpTask` (+ `FeatureClickUpTask` join to `Feature`, mirroring `GitHubIssue`/`FeatureIssue`), `GitLabIssue`/`GitLabEpic` (+ `FeatureGitLabIssue`; the account is a `ConnectedAccount` whose `metadata.baseUrl` names the instance and whose `metadata.credentialId` may borrow a git `CloudCredential`'s token)
- **Search:** `EmbeddingIndex` (content-hash bookkeeping for incremental indexing)

## Public API

`prisma` singleton + `export * from "./generated/prisma/client"`; subpaths `./client`, `./types`.

## Conventions

- Schema changes = new migration under `prisma/migrations/` (timestamped dir + `migration.sql`); never edit applied migrations.
- Auto-migrate on client construction is **skipped entirely** unless `NEXUX_MIGRATIONS_DIR` is set (`client.ts:20-22`). Otherwise migrate explicitly via `db:migrate` / `db:migrate:dev`.
- Two bookkeeping tables can coexist: `_prisma_migrations` (written by `prisma migrate dev`/`deploy`) and `_nexux_migrations` (written by the custom `ensureMigrated` runner). They track the same directory independently.
- Internal deps: `@nexux/config` only. `@nexux/embeddings` is the only package that depends on `db`; apps consume it directly.

## State

Mature, actively migrated (41 migrations).
