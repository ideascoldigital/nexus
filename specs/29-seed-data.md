# 29 — Seed data: a sandbox starts with a real database

Status: **phase 1 shipped** (2026-09-27) — seeds attach and are checked; nothing reaches a sandbox yet.

## Goal

A project can carry a database backup — a `.sql`, a `pg_dump -Fc`, a MySQL
dump, a Mongo archive — attached to one of its stack services. Every sandbox
launched for it comes up with that data already restored, *before* the repos
run their migrations, and a running sandbox can be put back to it in one
click. Development and agent runs work against data that looks like the real
thing instead of an empty schema.

## Why

An empty database is the most common reason an agent's run "works" and the
PR does not: the page renders with no rows, the query that times out on real
volumes is never exercised, the migration that breaks on existing data runs
against nothing. People fix this by hand every time, per sandbox.

The obvious fix does not work today, and silently. Stack services come up
**before** the repos are cloned (`template.ts`, "Stack services … come up
before repos are cloned so install/build/tests find their dependencies"), so
mounting a repo's `db/seed.sql` into `/docker-entrypoint-initdb.d` mounts a
path that does not exist yet: Docker creates an empty directory, Postgres
initialises an empty database, and nothing fails. `sandbox-compose.ts` only
warns that a host path "may not exist on the instance".

The workaround that does work — a repo install command that pipes the dump
into `docker compose exec -T postgres psql` — needs the dump in git, which
rules out anything large or anything with real data in it.

## Shape

```
Settings (project) ─ upload / pick file ─▶ <dataDir>/seeds/<projectId>/<seedId>/<file>
                                              │  SeedData row: service node, format, size, sha256
launch ─ bootstrap: stack:up ─▶ seed:wait ─▶ seed:restore ─▶ setup script ─▶ repos (clone, install = migrations)
            └─ server: pushLocalDir(seed) ──────┘  (docker cp · docker -H cp · scp)
running sandbox ─ "Reset data" ─▶ drop + restore, same script
running sandbox ─ "Save as seed" ─▶ dump from the service ─▶ fetch ─▶ new SeedData
```

### The seed

```prisma
model SeedData {
  id          String   @id @default(cuid())
  projectId   String
  stackNodeId String   // the service it restores into (a postgres/mysql/mongo node)
  fileName    String   // as uploaded, for display
  format      String   // "pg-sql" | "pg-custom" | "mysql-sql" | "mongo-archive" (+ ".gz" handled by the restorer)
  sizeBytes   BigInt
  sha256      String
  // A dump may carry real people's data. Marked by the user on upload; drives
  // the export rule and the warning on cloud launches. Defaults to true —
  // assuming a dump is safe is the expensive mistake.
  sensitive   Boolean  @default(true)
  enabled     Boolean  @default(true) // attached but not restored, without deleting it
  createdAt   DateTime @default(now())
  project     Project   @relation(fields: [projectId], references: [id], onDelete: Cascade)
  stackNode   StackNode @relation(fields: [stackNodeId], references: [id], onDelete: Cascade)
  @@unique([stackNodeId]) // one seed per service; replacing is re-uploading
}
```

The file lives at `<dataDir>/seeds/<projectId>/<seedId>/`, never in the
database and never in git. Deleting the row deletes the directory.

**Getting it in.** Two ways, because this install is usually the user's own
machine:

- **Pick a file on this machine** — a path the server reads directly. No
  upload, no size limit beyond disk. Offered only where the server and the
  browser are the same machine (not on a Nexus host reached over the tailnet).
- **Upload** — streamed from the request body to disk (never buffered whole),
  for a Nexus host or a remote browser. A size cap from settings, default
  2 GB, stated in the form.

**Format detection** reads the file, not the name: gzip magic → look inside;
`PGDMP` → `pg-custom`; `-- PostgreSQL database dump` / `-- MySQL dump` /
`-- MariaDB dump` headers → the SQL flavours; a Mongo archive header →
`mongo-archive`. A mismatch with the chosen service's image (a MySQL dump on a
postgres node) is refused at upload with both names in the message.

### Getting it onto the sandbox

Not through the bootstrap script: cloud-init user-data is capped at 16–64 KB
depending on provider, and a heredoc'd dump would be the whole script. The
file is pushed with `pushLocalDir`, which already covers every target —
`docker cp` for a local container, the same through `docker -H` for one on a
Docker endpoint (spec 26), `scp` for a VM — to
`/opt/nexus/.seeds/<service>/`, followed by a `.ready` marker written last.

The server pushes as soon as the instance is reachable, in parallel with the
bootstrap. The bootstrap does not assume it arrived: `seed:wait` waits for the
marker (bounded — default 15 min, longer when the size says so, then a
warning and the sandbox continues with an empty database; a missing seed is
not worth a dead sandbox).

### Restoring

A new bootstrap step, `seed:restore`, immediately after `stack:up` and before
the setup script and the repos:

| format | command, run inside the service container |
|---|---|
| `pg-sql` | `psql -v ON_ERROR_STOP=1 -U $POSTGRES_USER -d $POSTGRES_DB` |
| `pg-custom` | `pg_restore --no-owner --no-acl -U … -d …` |
| `mysql-sql` | `mysql -u root -p$MYSQL_ROOT_PASSWORD $MYSQL_DATABASE` |
| `mongo-archive` | `mongorestore --archive --drop` |

`.gz` is decompressed on the way in (`gunzip -c | …`). The user, password and
database come from **the service node's own env** (`POSTGRES_USER`, …) — the
same values the repos' `DATABASE_URL` points at — so the seed and the app can
never disagree about which database it went into.

Order matters and is the point: the restore lands before the repos' install
commands, which is where migrations run. A seed taken last month plus this
branch's new migrations is exactly the database the PR will meet.

The step reports through `bootstrap-report` like every other step: rows
restored per table where the tool says, duration, and on failure the last
lines of the restore's output. A failed restore is a `warn`, not a failed
sandbox.

### Reset data

A running sandbox gets **Reset data** (the sandbox row's menu, and
`POST /api/projects/[id]/sandboxes/[sid]/seed/reset`): stop nothing but the
database, drop and recreate it, run the same restore, then re-run the repos'
install step — where migrations live, and the same block **Retry setup**
already re-runs without re-cloning. The stack has no separate "migrate"
command today; adding one is not needed for this. The seed file is already
on the instance from launch, so a reset costs a restore, not a transfer.

### Save as seed

The other direction: **Save as seed** dumps the service in a running sandbox
(`pg_dump -Fc`, `mysqldump`, `mongodump --archive`), fetches it with the
existing `fetchRemoteDir`, and makes it the project's seed for that service —
replacing the old one after a confirm that names both sizes. For "I got the
data how I want it in this sandbox; start every next one from here".

## Safety

- **Never exported by default.** Config export (spec 18) leaves seeds out; a
  new export option includes non-sensitive ones, and sensitive ones only with
  `includeSecrets` and a second confirm. The file ships in the export bundle,
  not inlined in the JSON.
- **Cloud warning.** Launching a Civo/AWS sandbox with a `sensitive` seed says
  so before provisioning: the data leaves this machine for a VM you pay a
  provider to run. Local containers and Docker endpoints on your own network
  do not warn.
- **Integrity.** The sha256 is checked on the instance before restoring; a
  truncated transfer is a failed step, not half a database.
- **No credentials in the log.** The restore passes passwords through the
  container's env, never on a command line that ends up in the bootstrap log.

## MCP (spec 21)

- `nexux_reset_sandbox_data(sandboxId, service?)` — `sandboxes:write`. So an
  agent can start a test from known data.
- `nexux_list_sandboxes` gains `seed: { service, fileName, restoredAt } | null`
  per sandbox.

Upload and Save as seed stay out of MCP: moving a database dump around is a
decision a person makes.

## Not in v1

- Anonymisation. The `sensitive` flag and the warnings are what v1 does; a
  masking pass (per-column rules) is its own spec.
- Several seeds per service, or picking one per launch.
- Redis/Elasticsearch/MinIO seeds. The four formats above cover the databases
  the service catalog offers.
- Seeding a database the app runs itself (a SQLite file in the repo) — that
  already works as a file in git.

## Order

1. `SeedData` + storage, pick-a-file and streamed upload, format detection,
   the Settings card on the service node. Nothing reaches a sandbox yet.
2. Push + `seed:wait` + `seed:restore` on launch, for all three targets;
   bootstrap-report lines. Verified on a local container, on omarchy, and on
   one cloud VM.
3. Reset data (UI, route, MCP tool).
4. Save as seed; export rules; the cloud warning.

## As built (phase 1)

- `SeedData` (migration `20260928100000_seed_data`), plus `gzipped` as its own
  column rather than a `.gz` suffix on `format` — the restorer branches on it.
- `lib/seed/format.ts` (pure): `engineOfImage` (PostGIS, Timescale, MariaDB,
  Percona count as what they are; `postgres-exporter` does not),
  `detectSeedFormat` from the first 64 KB — decompressed when gzip — and
  `seedMismatch`. Headerless SQL is taken as the target engine's SQL: plain
  SQL carries no reliable dialect marker, and refusing hand-written seeds
  would be worse than trusting the node.
- `lib/seed/store.ts`: stream → staging dir with size + sha256 → detect →
  check → row (replacing the old one in a transaction) → rename. A refused
  file leaves nothing behind. A node deleted from the canvas cascades its row
  and the next listing sweeps its directory; deleting a project removes the
  whole `seeds/<projectId>` directory.
- Upload is the raw request body (`application/octet-stream`, XHR on the
  client for progress), capped by `NEXUX_SEED_MAX_BYTES` (default 2 GB),
  checked against `Content-Length` before reading and again while streaming.
- "Pick a file on this machine" is offered, and accepted, only when the
  request's Host is localhost/127.0.0.1/[::1] and this is not a Nexus host.
- The card sits in the stack inspector of a saved, docker-mode database
  service node. A replacement keeps the current `sensitive` flag.
- Tested: 6 format tests, 8 route tests (upload, gzip, mismatch leaves no
  staging dir, non-database refused, replace removes the old file, path only
  from this machine, orphan sweep, patch/delete). Walked in the browser on a
  throwaway project: a gzipped pg dump attached by path, a MySQL dump refused
  with both names, the upload endpoint over HTTP, cleanup on project delete.
