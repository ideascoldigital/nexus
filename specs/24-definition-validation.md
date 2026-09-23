# 24 — Proving a project definition boots

Status: **shipped** (2026-09-21 / 2026-09-23) — all four pieces.
Piece 1 `nexus_step` + `bootstrap-report.jsonl` (D-71) · piece 2 healthchecks
and the boot probe (D-72) · piece 4 the Validate action and its two MCP tools
(D-73) · piece 3 the prebuilt base image, measured at 52s → 23s (D-74).

## Goal

Answer one question the system cannot answer today: **would this project
definition actually come up?**

Today the only way to find out is to provision a sandbox and read a log. That
costs ~20 minutes, and the answer it gives is wrong in the optimistic
direction — a sandbox reports `running`, shows five green pills, and has never
once started the app.

## The two failures this fixes

**A definition nobody validated.** The wizard's four steps
([projects/new/page.tsx:33](../apps/web/src/app/\(dashboard\)/projects/new/page.tsx:33))
are all skippable, nothing gates progression, and the stack canvas starts
empty. A developer who has never written a compose file gets a blank canvas
and a Continue button.

**A sandbox that reports green without proving anything.** Two independent
holes make this worse than "unvalidated":

1. **The bootstrap never runs the app.** `runCommand` reaches
   `/opt/nexus/nexus.json` ([nexus-cli.ts:159](../packages/sandbox/src/nexus-cli.ts:159))
   and the process plans, but no bootstrap section invokes it. The box is
   declared ready having never proven the app compiles, binds or serves.
2. **Almost nothing is fatal.** Only the main repo's clone and its missing
   mount call `nexus_bootstrap_fatal`
   ([template.ts:551](../packages/sandbox/src/template.ts:551)). Every apt
   install, the docker install, `docker compose up` for postgres, every
   non-main clone, and **every install and build for every repo** degrade to
   `|| echo "[nexux] WARN: …"` ([template.ts:602](../packages/sandbox/src/template.ts:602)).
   The completion marker is written anyway.

The composite result: `SandboxHealthStrip` answers *is claude installed*, never
*does the app respond* ([task-manager.ts:1609](../apps/web/src/lib/task-manager.ts:1609)).

### Three smaller defects in the same area

Worth fixing here because the work touches them anyway.

**`--wait` guarantees nothing.** The bootstrap runs
`docker compose up -d --wait --wait-timeout 180`
([template.ts:871](../packages/sandbox/src/template.ts:871)), but
`generateCompose` emits **no `healthcheck` block, ever**
([compose.ts:100-190](../packages/harness/src/compose.ts:100)). Without one,
`--wait` waits for *running*, which for postgres is true several seconds
before it accepts connections — exactly the race a repo's install loses when
it runs migrations.

**Failure detection is a regex over prose.** `retrySandboxSetup` recovers the
failed steps by matching
`/^\[nexux\] WARN: (?:clone|install|build) failed for (.+?)$/gm`
([sandbox-manager.ts:336](../apps/web/src/lib/sandbox-manager.ts:336)). A
failed compose, a failed apt, a failed launcher match nothing — they are
invisible to retry and to the UI's failure count.

**Two completion signals that disagree.** `parseBootstrapLog` derives
`complete` from `/bootstrap finished/` against the tail
([bootstrap-log.ts:69](../apps/web/src/lib/bootstrap-log.ts:69)), while the
health route reads the marker file. A failed bootstrap prints
`bootstrap FAILED` ([template.ts:1265](../packages/sandbox/src/template.ts:1265)),
which does not match that regex — so the log viewer polls forever while the
health strip already knows. The regex is the bug: the log is untrusted text
(a repo's own build output can print anything), and completion is a fact the
marker already records.

## Shape

Four pieces, each shippable alone, in dependency order. Piece 1 is load-bearing
for the rest.

```
1. nexus_step + bootstrap-report.json   ← structured per-step results
2. healthchecks + in-bootstrap boot probe ← the actual "does it boot" answer
3. dry-run local sandbox                 ← makes the loop fast enough to use
4. validate action (UI + MCP tool)       ← exposes it
```

---

## Piece 1 — `nexus_step` and `bootstrap-report.json`

A bash helper in the bootstrap preamble, next to `nexus_bootstrap_fatal` and
`nexus_apt` ([template.ts:658](../packages/sandbox/src/template.ts:658)):

```bash
# Run one named bootstrap step, recording its outcome as JSON.
#
# Appends one object per line (JSONL, not an array): the bootstrap can be
# killed at any point — a timeout, a reboot, an OOM — and a partial array is
# unparseable while a partial JSONL file is simply shorter. Whatever ran is
# readable.
#
# Severity is the caller's decision, not the exit code's: a failed clone of the
# main repo is fatal, a failed tailscale install is not, and both exit 1.
nexus_step() {
  local name="$1" severity="$2"; shift 2
  local started=$(date +%s%3N) rc=0
  "$@" || rc=$?
  local ms=$(( $(date +%s%3N) - started ))
  nexus_step_record "$name" "$severity" "$rc" "$ms"
  [ "$rc" -ne 0 ] && [ "$severity" = "fatal" ] && nexus_bootstrap_fatal "$name failed"
  return 0   # never abort the run: see D-33
}
```

`nexus_step_record` writes one line to `/opt/nexus/bootstrap-report.jsonl`:

```json
{"step":"install:api","severity":"warn","exitCode":1,"durationMs":48211,"at":"2026-09-21T10:14:02Z"}
```

### Why JSONL and not a mutated JSON document

Because the writer is bash on a box that may die mid-run, and the reader is a
host polling over SSH. Appending a line is atomic enough at these sizes;
rewriting a document is not, and a truncated rewrite loses every prior step.

### Why severity is passed in, not derived

The bootstrap already has a working policy — main repo clone is fatal,
everything else is a warning — encoded as *which function the caller invokes*.
`nexus_step` makes that policy a parameter instead of a call-site convention,
which is what lets a reader tell "this failed and it matters" from "this failed
and the box is still useful". Deriving it from the exit code would collapse the
distinction that `nexus_bootstrap_fatal` exists to draw.

### Step naming

`<phase>:<subject>` — `apt:base`, `docker:install`, `stack:up`, `clone:api`,
`install:api`, `build:api`, `launcher:make-docker-up`, `boot:api`. The prefix
is what lets the UI group and the retry path select.

### Blast radius

Every `|| echo "[nexux] WARN: …"` in `template.ts` becomes a `nexus_step`
call. The `echo` stays — the log is still the human surface, and the tail is
what the UI streams live. This is additive: nothing reads the report until
piece 4.

`renderRepoSetup` ([template.ts:1301](../packages/sandbox/src/template.ts:1301))
is shared with `retrySandboxSetup`, so retry gets structured results for free —
and `sandbox-manager.ts:336`'s regex is deleted in favour of reading the
report.

### Two markers become three files

| File | Meaning | Kept? |
|---|---|---|
| `.bootstrap-complete` | run reached the end with no fatal step | yes — the host polls it, unchanged |
| `.bootstrap-failed` | one reason per line | yes — written by `nexus_bootstrap_fatal`, unchanged |
| `bootstrap-report.jsonl` | every step's outcome | new |

The markers stay exactly as they are. A new file is cheaper than changing the
contract two pollers and a health route already depend on
([sandbox-manager.ts:1063](../apps/web/src/lib/sandbox-manager.ts:1063)).

---

## Piece 2 — Healthchecks, and a boot probe inside the bootstrap

### Healthchecks in the catalog

`ServiceDef` ([service-catalog.ts:5](../apps/web/src/lib/stack/service-catalog.ts:5))
gains an optional `healthcheck`, and `generateCompose` emits it:

| Service | Test |
|---|---|
| postgres | `pg_isready -U $POSTGRES_USER` |
| mysql | `mysqladmin ping -h localhost` |
| mongo | `mongosh --eval 'db.adminCommand("ping")'` |
| redis | `redis-cli ping` |
| minio | `curl -f http://localhost:9000/minio/health/live` |
| ollama | `curl -f http://localhost:11434/api/tags` |

Interval 5s, timeout 3s, retries 12 — i.e. a minute of grace, well inside the
existing 180s `--wait-timeout`.

This is the whole fix for the migration race: `--wait` starts meaning what the
bootstrap already assumed it meant. A custom service the user typed by hand
gets no healthcheck and behaves exactly as today.

### The boot probe

The probe already exists, in the wrong place —
[sandbox-process-manager.ts:288](../apps/web/src/lib/sandbox-process-manager.ts:288)
starts the process, curls `localhost:<port>` for up to 180s, and emits
`APP_FAILED` with 25 log lines. That is precisely the evidence a validation run
needs, and it only ever happens when a human clicks Start.

So: extract the probe into a shared renderer and call it from the bootstrap's
tail, as `boot:<repo>` steps, for each repo with a `runCommand` and a port.

**The probe starts the app, waits for the port, and kills it.** A validation
run proves the app boots; it does not leave it running. Leaving it up would
make every provision also a deploy, and would race with the user's own Start.

```
boot:api  → start → port answers in 34s → kill → {exitCode: 0, durationMs: 34210}
boot:web  → start → 180s, no answer      → kill → {exitCode: 1, tail: "…EADDRINUSE…"}
```

On failure the step records a `tail` field (25 lines, same as today). It is the
one step whose failure is worth carrying inline: "did not answer on port 3000"
without the log is not actionable.

### Why this does not belong behind a flag

It is the only step that tests the thing the sandbox exists for. A provision
that skips it is the provision we have today, and that one lies. The cost is
bounded by the same 180s the manual path already accepts.

Open: whether a *task* sandbox (provisioned to run an agent, not to be looked
at) should skip it. Leaning no — an agent handed a project that does not build
wastes far more than 180s.

---

## Piece 3 — The dry-run sandbox

Piece 2 makes the answer correct. It does not make it fast: a local sandbox is
byte-identical to a cloud one ([local.ts:171](../packages/sandbox/src/local.ts:171)
calls the same `renderCloudInit`, only `mode: "container"`), so every dry run
pays apt update, build-essential, NodeSource, `get.docker.com`, a global
`npm i -g @anthropic-ai/claude-code`, the gh keyring, a glab `.deb`, and
`playwright install --with-deps chromium` — into a bare `ubuntu:22.04` with no
layer cache. That is what the 20-minute ceiling at
[sandbox-manager.ts:1060](../apps/web/src/lib/sandbox-manager.ts:1060) is
calibrated for.

Three levers, all already in the code:

| Lever | Where | Saves |
|---|---|---|
| Bind mounts instead of clone | [local.ts:110](../packages/sandbox/src/local.ts:110) | clone time, and the entire git-token / tailnet failure class |
| Prebuilt base image | `BASE_IMAGE` ([local.ts:16](../packages/sandbox/src/local.ts:16)) | apt + Node + Docker + CLIs |
| Skip agent installs | `installAgentBrowser` / `installClaudeCode` / `installOpenCode` already gate their sections | Chromium, the single longest step |

A dry run is therefore: local provider, bind mounts, prebuilt base, agents off.
What remains is exactly what is being validated — `stack:up` → `install:*` →
`build:*` → `boot:*`.

### The base image

A `nexux/sandbox-base:<tag>` built from the same bootstrap sections that
install tooling, with a `Dockerfile` generated from `renderCloudInit`'s tooling
half. Built on demand, cached; `BASE_IMAGE` falls back to `ubuntu:22.04` when
absent, so nothing breaks on a machine that has never built it.

**This is the piece most likely to be cut.** It is the largest, and the other
two levers alone already take a dry run from ~20 minutes to a few. Ship 1, 2
and 4 without it; add it when the loop still feels slow.

### Why not reuse a paused sandbox instead

`resumeLocalSandbox` ([local.ts:305](../packages/sandbox/src/local.ts:305))
revives a bootstrapped box in ~30-40s, which is faster than any of this. But a
validation run has to prove a *definition*, and a warm box has already been
mutated by the previous run's installs — the second run would pass on a
`node_modules` the first one left behind. Validation needs a cold box on
purpose; resume stays what it is, a way back into a box you were using.

---

## Piece 4 — The `validate` action

### UI

A **Validate** button in the stack toolbar, between the existing
"Preview compose" ([stack-toolbar.tsx:56](../apps/web/src/components/stack/stack-toolbar.tsx:56))
and **Up**. It runs a dry-run sandbox and streams the report as a step list:

```
✓ stack:up            postgres, redis        12.4s
✓ install:api         pnpm install           48.2s
✗ build:api           pnpm build              6.1s   exit 2
  …src/db.ts(4,22): error TS2307: Cannot find module '@/generated/prisma'
· boot:api            skipped (build failed)
```

Steps run in canvas dependency order; a failed `build:*` skips that node's
`boot:*` but not other nodes', matching `prepare`'s existing
failure-is-not-abort policy ([runner.ts:813](../apps/web/src/lib/stack/runner.ts:813)).

Validation status is stored on the project — last run's timestamp, verdict and
report — so the wizard can show a badge on the stack step, and so the result
survives a reload. Not a gate: the wizard stays skippable. An unvalidated
project is allowed; an unvalidated project that *looks* validated is not.

### MCP

One new tool in `packages/mcp/src/tools/write.ts`, scope `write` (it spends a
container, and on the cloud provider it would spend money):

```
nexux_validate_stack(projectId, provider?: "local")
  → { verdict: "ok" | "failed", steps: [...], report: "…" }
```

Plus `nexux_get_definition(projectId)` in `read.ts` — the current document
sections and the stack graph — because a Claude asked to fix a stack has to
read one before it can propose a change.

This is the piece that makes the definer agents useful rather than decorative.
They are single-turn against a hosted model with no feedback loop
([project-definer-agents.ts:184](../apps/web/src/services/project-definer-agents.ts:184));
no amount of prompt improves an agent that cannot check its own answer. A
`validate` that returns `error TS2307: Cannot find module` closes the loop:
propose → validate → read the failure → correct.

Per the local-first rule, this is a tool a **manual** `claude code` session
calls over `/api/mcp`. Nothing here runs headless Claude on the host; the
sandbox remains the only sanctioned place for that.

---

## Blast radius

| File | Change |
|---|---|
| `packages/sandbox/src/template.ts` | `nexus_step` + `nexus_step_record` in the preamble; every `\|\| echo WARN` wrapped; boot probe section |
| `packages/sandbox/src/local.ts` | `BASE_IMAGE` resolution (piece 3) |
| `packages/sandbox/src/index.ts` | export the report path + parser |
| `packages/harness/src/compose.ts` | emit `healthcheck` |
| `apps/web/src/lib/stack/service-catalog.ts` | `healthcheck` per service |
| `apps/web/src/lib/sandbox-manager.ts` | read the report; delete the WARN regex at `:336` |
| `apps/web/src/lib/bootstrap-log.ts` | `complete` from the marker, not `/bootstrap finished/` |
| `apps/web/src/lib/sandbox-process-manager.ts` | extract the probe renderer |
| `apps/web/src/components/stack/stack-toolbar.tsx` | Validate button + report panel |
| `packages/mcp/src/tools/*.ts` | `nexux_validate_stack`, `nexux_get_definition` |
| `packages/db` | project validation status columns |

## Resolved

**Why not just make more steps fatal?** Because a sandbox missing tailscale is
still a useful sandbox, and aborting loses the diagnostic context the rest of
the run produces — the reasoning already recorded at
[template.ts:656](../packages/sandbox/src/template.ts:656). The problem is not
that failures are non-fatal, it is that they are *unreadable*. Structured
results fix the reporting without changing the policy.

**Why not `docker compose config` as the validation?** It catches YAML and
schema errors, which the generator already cannot produce — it builds the
document from typed nodes and `stringify`s it. It would not have caught a
single real failure in the list above. Worth adding as a cheap pre-flight
inside piece 4, but it is not the answer.

**Does validation block the wizard?** No. Every step after the first is
skippable today and stays that way.

## Open questions

1. **Does a task sandbox run the boot probe?** Leaning yes (see piece 2).
2. **Where does validation status live** — columns on `Project`, or a
   `ValidationRun` table with history? History is more useful ("it broke
   between Tuesday and today") and costs a migration. Undecided.
3. **Multi-repo boot order.** The probe starts one app at a time and kills it.
   A front end whose boot needs its back end running will fail alone. Either
   the probe honours canvas edges and keeps dependencies up for the duration,
   or the first version documents the limitation. Leaning: honour edges, since
   `getStackInheritance` already knows the graph.
4. **Cloud dry runs.** Piece 3 is local-only. Validating a stack that genuinely
   needs a cloud provider (a GPU, a licensed base image) has no fast path.
   Probably fine — validate locally, provision remotely — but unproven.
