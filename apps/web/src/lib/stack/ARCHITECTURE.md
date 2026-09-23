# `lib/stack` — Architecture

> The Stack feature: a per-project graph of repos and infra services that can be detected, drawn on a canvas, generated into compose YAML, run on the host, and inherited by sandboxes.

The canvas UI lives in `components/stack/*`; this directory is the logic behind it.

## The graph

A project's stack is `StackNode` + `StackEdge` rows (`@nexux/db`), surfaced as `StackGraph`.

- **Node kinds:** `repo` (one of the project's repositories) or `service` (infra from the catalog, e.g. postgres).
- **Run modes:** `docker` (becomes a compose service) or `local` (runs as a host process). One graph can mix both.
- **Edges:** `source → target` means *source depends on target*, so the target starts first.

## Client/server split

Everything is imported by both API routes and canvas components, so the boundary matters:

| Client-safe (pure, no node builtins) | Server-only (`child_process` / `fs` / `net` / Prisma) |
|---|---|
| `types.ts`, `phases.ts`, `service-catalog.ts`, `suggestions.ts`, `dotenv.ts` | `runner.ts`, `detect.ts`, `compose-io.ts`, `node-runtime.ts`, `sandbox-compose.ts`, `sandbox-inheritance.ts` |

Keep new pure helpers in the left column — the assistant panel re-parses persisted messages in the browser and depends on it.

## Modules

| File | Role |
|---|---|
| `types.ts` | Every shared type: `StackNodeDTO`, `StackGraph`, `DetectionResult`, `StackStatus`, `StackInheritance`, `StackPhase`, assistant suggestion shapes |
| `phases.ts` | `phasesOf(node)` — a node's commands as ordered phases, derived from the legacy columns (see below) |
| `runner.ts` | `stackRunner` singleton — `up` / `down` / `status` / `getLogs` / `subscribe`. The bulk of the directory |
| `detect.ts` | `detectRepo(localPath)` — scans a repo for Dockerfile, compose, Makefile targets, package manager, scripts, `.env.example` keys, candidate ports. Make targets are read *by recipe*, not just by name (see below) |
| `compose-io.ts` | Loads the graph, generates YAML via `@nexux/harness`, writes it under `<workspace>/.nexux/` |
| `node-runtime.ts` | Resolves *where* and *how* a local node runs: `resolveNodeDir`, `resolveScriptCommand`, `nodePorts`, `portInCommand`. Shared by the runner and sandbox provisioning so both get the same answer |
| `sandbox-inheritance.ts` | `getStackInheritance` — what a sandbox takes from the canvas (see below) |
| `sandbox-compose.ts` | Docker **service** nodes → compose YAML for a sandbox. Never touches local paths; repo nodes run bare on the instance via `RepositorySetup` |
| `units.ts` | Spec 25 p1: `findRunnableUnits` — the workspace declaration expanded into directories, so a monorepo contributes one unit per app. No declaration = one unit at the root |
| `seed.ts` | Spec 25 p1: `seedStack` — units + detection → nodes, inferred services, edges. Pure; the evidence for every inference is attached to the node |
| `repair.ts` | Spec 25 p2: `reviewRepairs` — what a repair may and may not do. The rules live here, not in the prompt: a prompt is a request, this is the only thing that writes |
| `validate.ts` | Spec 24 p4: the static checks behind the Validate action |
| `service-catalog.ts` | `SERVICE_CATALOG` of common infra images + default ports/env/volumes |
| `suggestions.ts` | Parses and sanitizes the assistant's trailing ```json suggestion block |
| `dotenv.ts` | `.env` parser (multi-line quoted values) + `mergeEnv`. Shared: the inspector's import button and the sandbox settings' env-var import, which uses `parseDotenvWithDiagnostics` to preview skipped lines |

Compose service-name slugging is **not** here: `slugifyServiceName` comes from `@nexux/harness/compose`, the same function compose generation uses, so canvas status mapping and generated YAML cannot disagree. The `./compose` subpath exists so client components can import it without pulling the package barrel (which re-exports `docker.ts` and its `child_process` import) into the browser bundle.

## Phases (spec 17)

`runMode` + a pile of command columns cannot describe a repo that installs on
the host, brings infra up in Docker and *then* runs the app — expressing that
needed two nodes for one repo. A node is an ordered `StackPhase[]`, each phase
declaring a `role` (`install` → `build` → `services`/`run` → `stop`) and an
`exec` (`host`, `compose`, `compose-extern`, `container`).

**Phases are the source of truth**, persisted in `StackNode.phases`. The command
columns are still written from them (`columnsOf`) so a rollback, or a reader not
yet migrated, sees a coherent node; they drop once nothing reads them.

Read a node with `nodePhases(node)`, never `node.phases` directly — rows written
before the cutover hold null and are derived from the columns via `phasesOf`,
and a malformed stored value falls back the same way rather than blanking the
node. `pnpm --filter @nexux/web stack:backfill-phases` fills old rows in.

Both writers keep the two halves in step:

- **PUT /stack** takes `phases` when sent, derives them from the columns when
  not, and writes the columns back from whichever won. Detection is read off the
  stored row — the payload never carries it, so a launcher would otherwise lose
  its `composePath`/`provides` on every save.
- **POST /stack/detect** re-derives phases after a rescan, since a fresh scan can
  change what a command *means*. Phases edited by hand are left alone: the
  rescan knows better about what a command does, not about what the user wants.

The inspector edits both faces. Editing a command field re-derives the phases;
editing a phase mirrors back into the columns. Without that, whichever half the
user did not touch would silently win on save.

What phases buy today:

- `needsContainerRuntime(phases)` replaces `runMode === "docker" || managesServices`,
  which missed a `make dev` whose recipe is `docker compose up` — the recipe is
  read via `makeTargetOf`, so the phase carries `exec: "compose-extern"`.
- A launcher's phase carries `composePath` and `provides`, so status and
  teardown can name what they are acting on instead of scanning directories.
- The app node is "the node with a `run` phase" rather than
  `!managesServices && localCommand` — a launcher has a `services` phase, so it
  cannot be mistaken for the app.

`managesServices` still decides launcher-vs-app: it is the user's explicit
answer and outranks detection, which only supplies `detached` when nobody said.

`install`/`build` phases run on the host through `stackRunner.prepare` — the
**Prepare** toolbar button, deliberately not folded into Up. A cold install
takes minutes, and Up is meant to start what is already prepared. Until this
existed those two commands only ever ran inside a sandbox, so the canvas showed
fields that did nothing locally.

### Repeated roles

A role may repeat: two `run` phases for two servers out of one checkout, two
`services` phases bringing up separate stacks. **Readers take all of them** —
`runPhases`, `servicePhases`, `phasesWithRole`, `commandsOf` are the plural
helpers; `runPhase` (singular) survives only for callers that genuinely need one
answer, like a sandbox's single preview port.

Two places cannot hold more than one command and collapse repeats into an `&&`
sequence: the legacy columns (`columnsOf`) and a repo's sandbox bootstrap slots
(`repoCommands`). `&&` rather than `;` because a step whose predecessor failed
has nothing to run against. Phases stay the real answer; this is only what those
single-valued surfaces can express.

The runner keys `localProcs` by `nodeId#index`, not by node — otherwise a second
run phase would overwrite the first and leave it unstoppable. `status` collapses
those processes back per node (the canvas keys status by node): the node counts
as running while any of its phases is. Service launchers pair with stop phases by
position, except that a single stop phase is taken to undo whatever the node
started.

Still open (ordering phases *across* nodes): `specs/17-stack-phases.md`.

## Make targets hide Docker

A target's name says nothing about what it does: `make dev` may be a bare
`next dev` or a `docker compose up -d`. Reading only names meant `needsDocker`
came back false for repos that cannot run without Docker, and the sandbox
booted without it.

`parseMakeTargets` therefore reads each **recipe** and returns `MakeTarget[]`
(`makeTargetDetails` on `DetectionResult`; `makeTargets` stays as the plain
name list the UI already consumed):

- `usesDocker` — the recipe drives docker/podman, compose or a bare `docker run`.
- `composeFiles` / `composeServices` — what a compose call names. Only flags
  *before* the verb are files: in `compose logs -f api`, `-f` means *follow*.
- `detached` — `-d`/`--detach`, or a verb that returns on its own (`down`).
- `teardown` — the name reads like teardown, which drives the stop-command picks.
- Prerequisites are resolved depth-first, so `dev: up` inherits `up`'s Docker
  (cycles resolve to the self-only answer rather than looping). Detachment is
  *not* inherited — a blocking recipe stays blocking.

`$(VAR)` expansions are reduced to the variable's *name*, not dropped: the
common `$(DOCKER_COMPOSE) up -d` says "docker" nowhere else. Each such word is
sentinel-marked so it can prove intent without being mistaken for a real path
or service name.

Consequences: `getStackInheritance` flags `needsDocker` for a local node whose
`make` command drives containers even when nobody ticked `managesServices`, and
the inspector badges those targets and sets `managesServices` when one is picked.

## Runner

In-process singleton cached on `globalThis` (same HMR-survival pattern as `packages/db/src/client.ts`), so a dev reload does not orphan running processes.

- **Docker nodes** are handed to `docker compose`; compose owns their ordering via `depends_on`.
- **Local nodes** are spawned as detached process *groups*, so a whole dev-server tree can be signalled at once. They start in dependency order (`orderLocalNodes`, a DFS over the edges); cycles and unknown nodes keep their original position rather than dropping out.
- Before starting a node, the runner waits for its dependencies' ports (`DEP_READY_TIMEOUT_MS`, 60s) and then starts anyway rather than failing the whole stack.
- `status` distinguishes a node *Nexux started* from one already listening — an `external: true` entry means something outside Nexux holds the port (a manual `pnpm dev`).
- Stopping prefers a node's `stopCommand`, then escalates SIGTERM → SIGKILL after `SIGKILL_GRACE_MS`.
- Logs are a per-project ring buffer (`LOG_BUFFER_SIZE`, 2000 lines) multiplexed from compose and every local node; `subscribe` streams them to the logs panel.

`managesServices` marks a node whose command only launches background work and exits (`make docker-up`) — it is up when its containers are, not when its process lives.

## Sandbox inheritance

The stack already knows how a project runs, so sandboxes read it instead of re-stating it. `SandboxConfig` and `RepositorySetup` previously duplicated the run command and preview port, and the two drifted — a node saying `pnpm dev --port 3003` against a sandbox previewing 3000.

`getStackInheritance` makes the canvas the source of truth, returning the boot command and preview port, whether anything `needsDocker`, per-repo install/build/run commands, and `serviceLaunchers` for repo-owned scripts that bring containers up. Consumed by `sandbox-manager` and `task-manager`.

## Consumers

- **API:** `/api/projects/[projectId]/stack/*` — `detect`, `compose`, `up`, `down`, `status`, `logs`, `inheritance`, `assistant`, plus the base `route.ts` (GET graph / PUT save).
- **UI:** `components/stack/*` (canvas, inspector, sidebar, toolbar, logs, assistant panel).
- **Server:** `lib/sandbox-manager.ts`, `lib/task-manager.ts`, `services/stack-assistant-agent.ts`.
- Project bootstrap pre-seeds nodes/edges from a template (`lib/bootstrap/templates.ts`, see D-12).

## Conventions

- Client ids may be temporary (`tmp-…`) on save; the PUT reconciles them.
- Detection is a *suggestion* — a node's explicit command always beats a detected guess.
- `stopCommand` / `installCommand` / `buildCommand` are optional; absent means "nothing to do", not "use a default".
