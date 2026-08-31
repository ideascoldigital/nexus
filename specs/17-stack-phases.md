# 17 — Stack node phases

## Goal

Replace a stack node's single `runMode` + loose command columns with an
ordered list of **phases**, each declaring *what it does* and *how it
executes*. A node stops being "docker or local" and becomes a description of
the steps that make that piece of the project run.

The trigger is a real gap: `make docker-up` is stored as a plain string with a
`managesServices` boolean next to it. That boolean cannot say which containers
the command starts, whether the process survives, or how to tear it down — so
the runner, the sandbox provisioner and the compose generator each re-derive
the answer with a different heuristic, and disagree.

## Why the current model runs out

Today a `StackNode` carries `runMode: "docker" | "local"`, five command columns
(`command`, `installCommand`, `buildCommand`, `localCommand`, `stopCommand`)
and `managesServices: boolean`.

**1. `managesServices` is a boolean where a type is needed.**
It marks "the command launches background work and exits". But `make docker-up`,
`docker compose up -d` and `make dev` (which runs `docker compose up` *and*
`npm run watch`) are three different things collapsed into one flag. Nothing
records which containers were started, so liveness is guessed by looking for
*any* compose project in the node's directory
(`runner.ts` `composeDirsUp`), and teardown depends on the user having filled
`stopCommand` by hand.

**2. `runMode` is binary where the real case is mixed.**
A repo with a Makefile installs on the host (`pnpm i`), brings infra up in
Docker (`make docker-up`) and runs the app on the host (`pnpm dev`). Expressing
that today needs **two nodes for the same repo** plus an edge between them.
`getStackInheritance` then has to guess which of the two is "the app" by
filtering `!managesServices` — a heuristic that breaks as soon as a project has
two launchers.

**3. Phases exist already, but only in the sandbox.**
`installCommand` and `buildCommand` are *never executed by the host runner* —
only `@nexux/sandbox`'s `template.ts` runs them. The canvas shows fields that do
nothing locally. Phases make that asymmetry explicit and fixable instead of
surprising.

**4. A command's execution kind is not recorded.**
Spec 17's predecessor work (deep Makefile detection, shipped) can now tell that
`make dev` is `docker compose up` underneath — but there is nowhere on the node
to *store* that conclusion. It is recomputed from `detection` on every read.

## The model

```typescript
/** How a phase's command executes — what owns the process. */
export type ExecKind =
  | "host"           // a process on the host / sandbox instance
  | "compose"        // a service in the compose file Nexux generates
  | "compose-extern" // delegated to a compose file the repo owns
  | "container";     // a single image, no compose

/** What a phase is for. Order within a node is the order they run. */
export type PhaseRole = "install" | "build" | "services" | "run" | "stop";

export type StackPhase = {
  role: PhaseRole;
  exec: ExecKind;
  command: string | null;
  /** Image, when exec is "container" or "compose". */
  image?: string | null;
  /** Compose file the command drives, when exec is "compose-extern". */
  composePath?: string | null;
  /** Container/service names this phase brings up, when known. */
  provides?: string[];
  /** The command exits once its background work is launched. */
  detached?: boolean;
  /** Where the command runs, relative to the repo root. */
  workdir?: string | null;
};
```

A node becomes:

```typescript
export type StackNodeDTO = {
  // identity, position, ports, env, volumes, detection — unchanged
  phases: StackPhase[];
};
```

### What each problem above becomes

| Today | With phases |
|---|---|
| `localCommand` + `managesServices: true` | `{ role: "services", exec: "compose-extern", command: "make docker-up", composePath: "docker-compose.yml", provides: ["postgres","redis"], detached: true }` |
| two nodes for one mixed repo | one node: `install(host)` → `services(compose-extern)` → `run(host)` |
| `needsDocker` heuristic | `phases.some(p => p.exec !== "host")` |
| `stopCommand` column | `{ role: "stop", ... }`, and its absence means "nothing to do" |
| `runMode` | derived: `phases.every(p => p.exec === "host") ? "local" : "docker"` |

`provides` is the one that pays for the change: the runner can ask
`docker compose -f <composePath> ps` for real status instead of scanning
directories, and `down` knows what it is tearing down.

## Compatibility

`runMode` stays as a **derived, read-only** value on the DTO, so the canvas
badge, `sandbox-compose.ts` filtering and the compose generator keep working
untouched during the migration.

## Migration

Two-step, each shippable on its own.

**Step 1 — additive.** Add `phases Json?` to `StackNode`. Write a pure
`phasesOf(node): StackPhase[]` that derives phases from the existing columns
(the columns stay the source of truth). Every consumer moves to reading
`phasesOf(node)`; nothing writes `phases` yet. This is behaviour-preserving and
independently testable — a node with `localCommand: "make docker-up"` and
`managesServices: true` must derive exactly the launcher phase above.

**Step 2 — cut over.** The PUT route starts persisting `phases`; a migration
backfills the column for existing rows; the inspector edits phases directly.
The old columns become derived-for-compat, then drop in a later migration.

Deriving-before-persisting is what keeps step 1 safe: if `phasesOf` is wrong for
some real project, it shows up while the columns are still authoritative.

## Blast radius

Reads `runMode` / the command columns today, so each needs a pass in step 1:

- `lib/stack/runner.ts` — `up`, `startLocalNode`, `down`, `runStopCommands`, `status`
- `lib/stack/sandbox-inheritance.ts` — `needsDocker`, `serviceLaunchers`, `repoCommands`, app-node pick
- `lib/stack/sandbox-compose.ts` — the `kind === "service" && runMode === "docker"` filter
- `lib/stack/compose-io.ts` → `@nexux/harness` `generateCompose` (`StackNodeSpec.runMode`)
- `lib/sandbox-manager.ts` — `installDocker`, `stackLaunchers`, per-repo commands
- `app/api/projects/[projectId]/stack/route.ts` — the PUT zod schema
- `components/stack/*` — inspector fields, canvas node creation, assistant suggestions

## Resolved

**Does the host runner start running `install`/`build`?** Yes, but as its own
action — `stackRunner.prepare`, behind a **Prepare** button, not folded into Up.
Up stays the cheap "start what is already prepared"; a cold `pnpm install` would
otherwise make it take minutes. Steps run in dependency order and a failure is
logged and skipped rather than aborting the rest, matching `runStopCommands`.

**What happens to the old columns?** Dual write, phases winning. Both writers
(`PUT /stack`, `POST /stack/detect`) persist phases and derive the columns from
them via `columnsOf`; the columns drop in a later migration once nothing reads
them. `columnsOf(phasesOf(node))` is the identity — tested, and verified against
all 9 nodes in the local database.

**Multiple phases of the same role?** Allowed, and every reader honours all of
them. The plural helpers (`runPhases`, `servicePhases`, `phasesWithRole`,
`commandsOf`) are the default; `runPhase` stays for callers that genuinely need
a single answer, like a sandbox's one preview port. Where a surface can only
hold one command — the legacy columns, a repo's bootstrap slots — repeats
collapse into an `&&` sequence. The runner keys its process map by
`nodeId#index` so a second run phase cannot overwrite the first, and `status`
collapses back per node for the canvas.

## Open questions

1. **Ordering across nodes.** Phases order *within* a node; edges order
   *between* nodes. A `services` phase that another node depends on has to be
   ready before that node's `run` phase — does the runner interleave phases
   across nodes, or run each node's phases as a unit? Today `up` still treats a
   node as a unit: it starts all of that node's run and service phases, then
   moves on.
