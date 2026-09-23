# 25 — "Here are my repos, make it work"

Status: **pieces 1–2 shipped** (2026-09-23) — the seed (D-75: units, inferred
services and edges, plus the migration that let a repository own more than one
node) and the repair loop (D-76: validate → patch → re-validate, with the rules
in the applier rather than the prompt). Piece 3, the lockfile, remains design.
Depends on [spec 24](24-definition-validation.md), which is complete.

## Goal

Hand Nexux a set of repos and get back a stack definition that provably boots,
without opening the canvas.

Spec 24 answers *did it boot*. It leaves the developer as the one who writes
the definition and the one who fixes it when the answer is no. This spec closes
both ends:

```
repos → seed → validate → [fails] → repair → re-validate → lock
               └── spec 24 ──┘                  └ spec 24 ┘
```

The two outer arrows are what is missing. The middle is spec 24 and is assumed
working here.

## Why the canvas is empty

Detection is genuinely good and genuinely unused. `detectRepo`
([detect.ts](../apps/web/src/lib/stack/detect.ts)) finds the Dockerfile, the
compose file, the package manager (preferring corepack's `packageManager:` over
a lockfile, and refusing an untracked lockfile via `isGitTracked`
([detect.ts:51](../apps/web/src/lib/stack/detect.ts:51))), the scripts, the env
keys, the exposed ports — and parses **each Makefile target's recipe**, so a
`make dev` that is secretly `docker compose up -d postgres` is recorded as
`usesDocker`, `detached`, `composeServices: ["postgres"]`
([types.ts:53](../apps/web/src/lib/stack/types.ts:53)).

All of that fires only when a human drags a repo onto the canvas
([stack-canvas.tsx:425](../apps/web/src/components/stack/stack-canvas.tsx:425)),
and it prefills exactly one node. Nothing infers services, nothing draws an
edge, and a new project starts blank.

So the gap is not detection. It is that **nothing turns detection into a
graph.**

## Piece 1 — Seed the canvas

`POST /api/projects/[projectId]/stack/seed` — runs detection across every repo
and writes a starting graph. Idempotent by refusal: it declines on a non-empty
canvas rather than merging, because a merge has to guess which of the user's
edits were deliberate. Re-seeding is explicit (`{ replace: true }`).

### Run nodes

One per runnable unit, from `suggestedCommands` — which already prefers
package.json scripts and falls back to Makefile targets
([detect.ts:404-426](../apps/web/src/lib/stack/detect.ts:404)). `runMode`
follows the existing canvas rule: `hasDockerfile ? "docker" : "local"`.

A detected Makefile target that `usesDocker && detached` becomes a `services`
phase with `exec: "compose-extern"`, carrying `composePath` and `provides` from
`composeFiles` / `composeServices` — the shape spec 17 defined and that
detection already fills but nobody writes.

### A repo is not a node

The assumption worth killing before anything is built: **one repository does
not mean one node.** A project may be one repo, several repos, a single
monorepo holding a front end and an API, or a mix — and the seed has to produce
the same graph shape for all of them, because the stack cares about *runnable
units*, not about how many gits they arrived in.

```
2 repos, one app each          1 monorepo, two apps
  repo:web  → node web           repo:app → node web   (apps/web)
  repo:api  → node api                    → node api   (apps/api)
  (+ node postgres)                       (+ node postgres)
```

Both graphs are identical past the seed. Only the *discovery* differs.

So detection becomes two passes:

1. **Find the runnable units in a repo.** Read the workspace declaration —
   `pnpm-workspace.yaml`, `package.json` `workspaces`, `turbo.json`'s inferred
   set — and expand its globs into concrete directories. No declaration means
   one unit: the repo root, exactly as today.
2. **Detect each unit.** `detectRepo(localPath)`
   ([detect.ts:338](../apps/web/src/lib/stack/detect.ts:338)) already takes an
   arbitrary path, so a unit at `apps/api` is scanned by the same function that
   scans a repo root. Nothing about Dockerfile/Makefile/script detection needs
   to know it is inside a workspace.

Each node records the unit it came from (`repositoryId` plus a `workdir`
relative to the checkout) — which is the field `StackNode` already has
([types.ts](../apps/web/src/lib/stack/types.ts)) and that phases already carry.

**Not every workspace package is a node.** A workspace of nine libraries and
two apps must not become eleven nodes. A unit is runnable only if it has
something to run: a `dev`/`start` script, a Dockerfile, or a Makefile target
that detection flagged. A package with only `build` and `test` is a library —
it is built by its dependents' install, and has no place on a canvas that
describes what boots.

**The root still gets scanned.** A monorepo's root install (`pnpm install` at
the top) is what makes every unit installable, and its Makefile may hold the
`docker compose up` for the whole thing. The root contributes an install phase
and any service launchers; it does not become a run node unless it has its own
dev command.

**Ports across units are checked at seed time.** Two apps in one workspace that
both default to 3000 is common and is a boot failure spec 24 would catch three
minutes later. The seed catches it immediately: a collision is flagged on both
nodes with the evidence, unresolved rather than silently reassigned — picking a
port for someone changes the URL they expect.

### Inferred service nodes

This is the new inference. `envExampleKeys` plus the values
`parseEnvKeys` pulled out are read as evidence of a dependency:

| Evidence in `.env.example` | Service |
|---|---|
| `DATABASE_URL=postgres://…` / `POSTGRES_*` | postgres |
| `DATABASE_URL=mysql://…` / `MYSQL_*` | mysql |
| `REDIS_URL` / `REDIS_HOST` | redis |
| `MONGO_URL` / `MONGODB_URI` | mongo |
| `S3_ENDPOINT` + `AWS_ACCESS_KEY_ID` | minio |
| `OLLAMA_HOST` | ollama |

Matched against `SERVICE_CATALOG`
([service-catalog.ts:15](../apps/web/src/lib/stack/service-catalog.ts:15)), which
already carries image, ports, env and volumes.

**Scheme first, name second.** `DATABASE_URL=postgres://…` names its engine in
the URL; `DATABASE_URL` alone does not, and a project may well mean MySQL. When
only the key matches, the node is still created but flagged low confidence (see
below) — the alternative, silence, leaves the developer with the blank canvas
this spec exists to remove.

**A compose file the repo already owns wins.** If `hasCompose`, no service
nodes are inferred from env at all — the repo has declared its services and
duplicating them would start two postgres containers fighting over 5432. The
repo's compose becomes a `compose-extern` services phase instead.

**One service per project, not per unit.** Three units whose `.env.example`
each name `DATABASE_URL=postgres://…` want one postgres, not three. Services
are deduplicated by catalog key across the whole project; every unit that
produced the evidence gets an edge to the single node. Two units genuinely
wanting separate databases is real but rare, and is an edit — whereas three
postgres containers racing for 5432 is a boot failure nobody asked for.

### Edges

A unit depends on an inferred service when the evidence that created that
service came from that unit's `.env.example`. That is a real edge, not a guess:
the variable is in the unit's own example file.

**A monorepo's root `.env.example` is attributed to every unit under it**, and
flagged low confidence for each. The root file is the one place the evidence
genuinely is ambiguous — it may describe the API's database, or the whole
workspace's. Attributing it to all of them is the safe direction: an edge too
many delays a boot, an edge missing breaks one.

Unit-to-unit edges are **not** inferred. A front end's `API_URL` pointing at
`localhost:8000` and a back end exposing 8000 is suggestive, not conclusive,
and a wrong edge changes boot order in a way that is hard to debug. Left to
piece 2, which can read both units and explain itself. (This does not get
easier inside a monorepo — two apps in one git are no more related than two
gits, and treating co-location as evidence is exactly the wrong inference.)

### Confidence, and why it is on the node

Each seeded node records `seededBy: "detect" | "agent" | "user"` and a
confidence. The UI renders low-confidence nodes with a dashed border and the
evidence in the inspector: *"postgres — because `DATABASE_URL` in api/.env.example
does not name a scheme."*

A generated graph the user cannot interrogate is worse than no graph, because
they cannot tell which parts to trust. `seededBy` also gives piece 2 a rule: an
agent may rewrite `detect` and its own nodes, never a `user` one.

---

## Piece 2 — The repair loop

Validation from spec 24 returns structured steps with exit codes and, for a
failed `boot:*`, a log tail. A human reads `error TS2307: Cannot find module
'@/generated/prisma'` and knows the install is missing `prisma generate`. The
system does not.

So: feed the failure back in.

```
validate → failed steps → repair agent → patch → re-validate
              ↑                                       │
              └───────────── max 3 rounds ────────────┘
```

### The agent already exists

`stack-assistant-agent.ts` has the tools (`get_stack_context`,
`read_repo_file`, `search_project`) and — more importantly — already emits a
**patch format the UI applies in one click**
([stack-assistant-agent.ts:63-88](../apps/web/src/services/stack-assistant-agent.ts:63)):

```json
{ "suggestions": [ { "nodeId": "…", "patch": { "installCommand": "…" }, "reason": "…" } ] }
```

The repair loop is that same agent with a different prompt and a different
caller. It is given the failed steps, their log tails, and the node that owns
each failing step; it answers in the format that already exists. **No new
protocol.** The hand-rolled tool loop is kept as-is, including the reason it is
hand-rolled ([stack-assistant-agent.ts:10](../apps/web/src/services/stack-assistant-agent.ts:10)).

### Why it stops at 3 rounds

Each round costs a validation — a container, minutes, and on a cloud provider
real money. Three rounds is enough for the failure classes worth automating: a
missing codegen step, a wrong install command, a service that was needed and
not inferred, an env var with no value. Past that the agent is usually
guessing, and a guess that flips a working node is worse than a report.

A round that produces no patch stops immediately.

### Why it must not loop unattended without a diff

Every round's patches are recorded with their reason and the step that
motivated them. When the loop ends, the user sees what changed and why, and can
revert any single patch. An agent that silently rewrites a stack until it goes
green can go green by deleting the node that was failing.

Hard rules:

- Never delete a node. Patches only.
- Never touch a `seededBy: "user"` node without saying so prominently.
- Never weaken the check — a patch that removes a port, or a `runCommand`, is
  refused by the applier, not by the prompt. A prompt is a request; the applier
  is the guarantee.

### Modes

| Mode | Behaviour |
|---|---|
| **Propose** (default) | Validate, show failures and suggested patches. Nothing applies. |
| **Repair** | Validate → patch → re-validate, up to 3. Diff at the end. |

Propose is the default because the first run on a real project is the one most
likely to surprise.

---

## Piece 3 — The lockfile

"Reproducible" has no definition in the codebase today, and the largest source
of drift is structural: a local sandbox **bind-mounts** repo folders
([local.ts:110](../packages/sandbox/src/local.ts:110)) while a cloud sandbox
clones by URL. A stack validated locally was validated against your working
tree — uncommitted files and all.

So a validation that passed records what it passed *against*:

```json
{
  "lockVersion": 1,
  "validatedAt": "2026-09-21T10:14:02Z",
  "provider": "local",
  "source": "mount",
  "repos": [
    { "name": "api", "commit": "a1b2c3d", "dirty": true,
      "lockfile": "pnpm-lock.yaml", "lockfileSha256": "9f86d0…" }
  ],
  "services": [
    { "name": "postgres", "image": "postgres:17",
      "digest": "sha256:1a2b…", "healthcheck": true }
  ],
  "tooling": { "node": "22.11.0", "pnpm": "9.12.3", "docker": "27.3.1" }
}
```

Written at the end of a green validation, stored beside the validation status
spec 24 introduces.

### What it is for

**Explaining a regression.** It was green on Tuesday and red today: diff the
locks. `postgres:17` resolving to a new digest, or `pnpm-lock.yaml` changing,
is the answer — and is invisible today.

**Naming the local/cloud gap.** `source: "mount"` with `dirty: true` says in
one field that this passed against uncommitted work. The UI can then be honest:
*"Validated locally against uncommitted changes — a cloud sandbox clones and may
differ."* That sentence is the whole of what "reproducible" can truthfully mean
before a cloud validation runs.

### What it is not

Not a pin. Nothing reads the lock back to force a digest. Pinning images the
user did not pin is a decision with real consequences — a postgres that never
gets a security patch — and it is theirs to make. The lock **describes**; if
pinning is wanted later, it has the data to generate it.

---

## Where this lands in the UI

The stack step of the wizard gains a primary action on an empty canvas:
**"Set up from my repos"** → seed → validate → (Propose | Repair). The canvas
fills, then reports. Manual editing is unchanged and always available.

A validated project shows a badge with the lock summary: *"Boots — validated
2h ago against 3 repos, 1 uncommitted."*

## MCP

Spec 24 adds `nexux_validate_stack` and `nexux_get_definition`. This spec adds
two, both `write`:

```
nexux_seed_stack(projectId, replace?)   → { nodes, edges, lowConfidence[] }
nexux_repair_stack(projectId, maxRounds?) → { rounds[], patches[], verdict }
```

Which is what makes the whole thing reachable from a manual `claude code`
session: *"acá están mis repos, armá el stack y asegurate que levante"* becomes
seed → validate → repair → lock, with the developer reading a diff at the end
instead of a blank canvas at the start.

## Blast radius

| File | Change |
|---|---|
| `apps/web/src/lib/stack/units.ts` | new — workspace markers → runnable units; falls back to one unit at the root |
| `apps/web/src/lib/stack/seed.ts` | new — inference from detection to graph |
| `apps/web/src/app/api/projects/[projectId]/stack/seed/route.ts` | new |
| `apps/web/src/lib/stack/detect.ts` | unchanged — `detectRepo(localPath)` already scans an arbitrary directory |
| `apps/web/src/lib/stack/service-catalog.ts` | env-key → service evidence table |
| `apps/web/src/services/stack-assistant-agent.ts` | repair prompt + caller; suggestion format untouched |
| `apps/web/src/lib/stack/repair.ts` | new — the round loop, patch applier, refusal rules |
| `apps/web/src/lib/stack/lock.ts` | new — build and diff the lock |
| `apps/web/src/components/stack/stack-canvas.tsx` | empty-state action, confidence rendering |
| `packages/db` | `seededBy` + confidence on `StackNode`; lock storage |
| `packages/mcp/src/tools/write.ts` | `nexux_seed_stack`, `nexux_repair_stack` |

## Resolved

**Why not have the definer agents produce the stack?** They run against a
hosted model with no feedback loop and no filesystem access
([project-definer-agents.ts:184](../apps/web/src/services/project-definer-agents.ts:184)).
Detection reads the actual repo; the definer reads the conversation. For "what
does this repo need to run", the repo is the better source. The definer's
`tech-stack` and `architecture` sections stay what they are — intent, not
configuration.

**Why is a monorepo not a special case?** Because the alternative was a wrong
model, not a missing feature. Treating a repository as a node makes "one repo,
two apps" unrepresentable and "two repos, two apps" the only supported shape —
and a project may be either, or both. Discovering *runnable units* and then
detecting each one makes the number of gits irrelevant, which is what it
should have been: the stack describes what boots, and a git is how the code
arrived, not what runs.

**Why refuse to seed a non-empty canvas?** Because a merge cannot tell a
deliberate edit from a stale one, and silently reverting a user's fix is the
single worst outcome available here.

**Why is the repair agent the stack assistant and not a new one?** Its
suggestion format is already an applied patch with a reason, and its tools are
already the right three. A second agent would be a second definition of what a
stack patch is.

## Open questions

1. **Repo-to-repo edges.** Deferred from piece 1 to piece 2. Does the repair
   agent get to draw them, or only to suggest them to the user? Leaning: draw,
   since a wrong edge shows up as a boot failure in the very next round.
2. **Does repair run on a cloud provider?** Three rounds of cloud provisioning
   is real money. Probably local-only with an explicit override, but that makes
   a cloud-only stack unrepairable — the same gap spec 24 leaves open.
3. **Non-JS workspaces.** Unit discovery reads `pnpm-workspace.yaml`,
   `package.json` `workspaces` and `turbo.json`. A Go workspace
   (`go.work`), a Cargo workspace, a Python monorepo with several
   `pyproject.toml` — none are covered, and each would fall back to
   one-unit-at-the-root. The fallback is correct, just coarse; the table of
   markers is the extension point.
4. **Where the lock lives** — with the validation run, or committed into the
   repo like a real lockfile? Committed is more honest about what it is, and
   means the team shares it; it also puts Nexux-generated files in the user's
   repo, which nothing else here does. Undecided.
