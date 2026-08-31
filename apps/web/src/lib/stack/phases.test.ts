import assert from "node:assert/strict";
import test from "node:test";

import {
  columnsOf,
  commandsOf,
  needsContainerRuntime,
  nodePhases,
  parsePhases,
  phasesOf,
  phasesWithRole,
  runPhase,
  runPhases,
  servicePhases,
} from "./phases";
import type { DetectionResult, MakeTarget, StackPhase } from "./types";

const LOCAL = { kind: "repo", runMode: "local" };

/** A detection carrying one analysed make target. */
const detectionWith = (target: Partial<MakeTarget> & { name: string }) =>
  ({
    makeTargetDetails: [
      {
        prerequisites: [],
        usesDocker: false,
        composeFiles: [],
        composeServices: [],
        detached: false,
        teardown: false,
        ...target,
      },
    ],
  }) as unknown as DetectionResult;

test("a docker node is a single compose-owned services phase", () => {
  const phases = phasesOf({
    kind: "service",
    runMode: "docker",
    image: "postgres:17",
  });
  assert.deepEqual(phases, [
    {
      role: "services",
      exec: "compose",
      command: null,
      image: "postgres:17",
      detached: true,
      workdir: null,
    },
  ]);
  assert.equal(needsContainerRuntime(phases), true);
});

test("a plain local node is one host run phase", () => {
  const phases = phasesOf({ ...LOCAL, localCommand: "pnpm dev" });
  assert.equal(phases.length, 1);
  assert.equal(runPhase(phases)?.exec, "host");
  assert.equal(needsContainerRuntime(phases), false);
});

test("install and build come before run, in that order", () => {
  const phases = phasesOf({
    ...LOCAL,
    installCommand: "pnpm install",
    buildCommand: "pnpm build",
    localCommand: "pnpm dev",
  });
  assert.deepEqual(
    phases.map((p) => p.role),
    ["install", "build", "run"]
  );
  // They prepare a checkout rather than running it, so they are host steps.
  assert.deepEqual(
    phases.filter((p) => p.role !== "run").map((p) => p.exec),
    ["host", "host"]
  );
});

test("empty and whitespace-only commands produce no phase", () => {
  const phases = phasesOf({
    ...LOCAL,
    installCommand: "   ",
    buildCommand: null,
    localCommand: "pnpm dev",
  });
  assert.deepEqual(
    phases.map((p) => p.role),
    ["run"]
  );
});

test("a launcher becomes a services phase carrying what it starts", () => {
  const phases = phasesOf({
    ...LOCAL,
    localCommand: "make docker-up",
    managesServices: true,
    stopCommand: "make docker-down",
    detection: detectionWith({
      name: "docker-up",
      usesDocker: true,
      composeFiles: ["docker-compose.yml"],
      composeServices: ["postgres", "redis"],
      detached: true,
    }),
  });
  const [services, stop] = phases;
  assert.equal(services.role, "services");
  assert.equal(services.exec, "compose-extern");
  assert.equal(services.composePath, "docker-compose.yml");
  assert.deepEqual(services.provides, ["postgres", "redis"]);
  assert.equal(services.detached, true);
  assert.equal(stop.role, "stop");
  // A launcher is not the app, so there is nothing to boot.
  assert.equal(runPhase(phases), null);
  assert.deepEqual(servicePhases(phases), [services]);
});

test("a run command whose make recipe hides docker still needs a runtime", () => {
  // The case the old `runMode === "docker" || managesServices` reading missed:
  // nothing on the node says docker, only the scanned recipe does.
  const phases = phasesOf({
    ...LOCAL,
    localCommand: "make dev",
    detection: detectionWith({
      name: "dev",
      usesDocker: true,
      composeServices: ["db"],
    }),
  });
  assert.equal(runPhase(phases)?.exec, "compose-extern");
  assert.equal(needsContainerRuntime(phases), true);
});

test("a make target that uses docker without compose is a container phase", () => {
  const phases = phasesOf({
    ...LOCAL,
    localCommand: "make psql",
    detection: detectionWith({ name: "psql", usesDocker: true }),
  });
  assert.equal(runPhase(phases)?.exec, "container");
  assert.equal(needsContainerRuntime(phases), true);
});

test("a direct compose command needs no detection to be recognised", () => {
  const phases = phasesOf({ ...LOCAL, localCommand: "docker compose up -d" });
  assert.equal(runPhase(phases)?.exec, "compose-extern");
  assert.equal(needsContainerRuntime(phases), true);
});

test("a plain command stays a host phase even with docker siblings detected", () => {
  const phases = phasesOf({
    ...LOCAL,
    localCommand: "pnpm dev",
    detection: detectionWith({
      name: "docker-up",
      usesDocker: true,
      detached: true,
    }),
  });
  assert.equal(runPhase(phases)?.exec, "host");
  assert.equal(needsContainerRuntime(phases), false);
});

test("managesServices outranks a recipe that looks blocking", () => {
  const phases = phasesOf({
    ...LOCAL,
    localCommand: "make up",
    managesServices: true,
    detection: detectionWith({
      name: "up",
      usesDocker: true,
      composeServices: ["api"],
      detached: false,
    }),
  });
  assert.equal(phases[0].detached, true);
});

test("a detached recipe is inferred when the node was never marked", () => {
  const phases = phasesOf({
    ...LOCAL,
    localCommand: "make up",
    detection: detectionWith({
      name: "up",
      usesDocker: true,
      composeServices: ["api"],
      detached: true,
    }),
  });
  // Still a run phase — only the user says a node is a launcher — but the
  // recipe's own behaviour is recorded.
  assert.equal(phases[0].role, "run");
  assert.equal(phases[0].detached, true);
});

test("a blocking command records no detached flag at all", () => {
  const phases = phasesOf({ ...LOCAL, localCommand: "pnpm dev" });
  assert.equal(phases[0].detached, undefined);
});

test("workdir rides on every phase", () => {
  const phases = phasesOf({
    ...LOCAL,
    workdir: "apps/api",
    installCommand: "pnpm i",
    localCommand: "pnpm dev",
  });
  assert.deepEqual(new Set(phases.map((p) => p.workdir)), new Set(["apps/api"]));
});

test("a stop command keeps the compose file it tears down", () => {
  const phases = phasesOf({
    ...LOCAL,
    localCommand: "pnpm dev",
    stopCommand: "make docker-down",
    detection: detectionWith({
      name: "docker-down",
      usesDocker: true,
      composeFiles: ["infra.yml"],
      teardown: true,
    }),
  });
  const stop = phases.find((p) => p.role === "stop");
  assert.equal(stop?.composePath, "infra.yml");
  // It names a compose file, so the teardown is compose's to carry out.
  assert.equal(stop?.exec, "compose-extern");
});

test("a node with no commands at all has no phases", () => {
  assert.deepEqual(phasesOf(LOCAL), []);
  assert.equal(needsContainerRuntime([]), false);
});

// --- Persistence: phases are written, the columns are written from them ---

/** Columns → phases → columns must be the identity, or dual-writing lies. */
const roundTrips = (node: Parameters<typeof phasesOf>[0]) => {
  const columns = columnsOf(phasesOf(node));
  assert.deepEqual(columns, {
    runMode: node.runMode,
    installCommand: node.installCommand?.trim() || null,
    buildCommand: node.buildCommand?.trim() || null,
    localCommand: node.localCommand?.trim() || null,
    stopCommand: node.stopCommand?.trim() || null,
    managesServices: !!node.managesServices,
  });
};

test("a local app node round-trips through phases unchanged", () => {
  roundTrips({
    ...LOCAL,
    installCommand: "pnpm install",
    buildCommand: "pnpm build",
    localCommand: "pnpm dev",
    stopCommand: null,
    managesServices: false,
  });
});

test("a launcher round-trips, keeping managesServices", () => {
  roundTrips({
    ...LOCAL,
    localCommand: "make docker-up",
    stopCommand: "make docker-down",
    managesServices: true,
    detection: detectionWith({
      name: "docker-up",
      usesDocker: true,
      composeFiles: ["docker-compose.yml"],
      composeServices: ["postgres"],
      detached: true,
    }),
  });
});

test("a docker service node round-trips", () => {
  const node = { kind: "service", runMode: "docker", image: "postgres:17" };
  const columns = columnsOf(phasesOf(node));
  assert.equal(columns.runMode, "docker");
  assert.equal(columns.managesServices, false);
  assert.equal(columns.localCommand, null);
});

test("a node with a docker-driven run command stays local, not a launcher", () => {
  // The trap: the phase is compose-extern, but the user never marked it a
  // launcher — deriving managesServices from `exec` would flip it silently.
  roundTrips({
    ...LOCAL,
    localCommand: "make dev",
    managesServices: false,
    detection: detectionWith({
      name: "dev",
      usesDocker: true,
      composeServices: ["db"],
      detached: true,
    }),
  });
});

test("an empty node round-trips to empty columns", () => {
  assert.deepEqual(columnsOf([]), {
    runMode: "local",
    installCommand: null,
    buildCommand: null,
    localCommand: null,
    stopCommand: null,
    managesServices: false,
  });
});

test("persisted phases win over the columns", () => {
  const node = {
    ...LOCAL,
    localCommand: "pnpm dev",
    phases: [{ role: "run", exec: "host", command: "pnpm start" }],
  };
  assert.equal(runPhase(nodePhases(node))?.command, "pnpm start");
});

test("a node with no persisted phases falls back to deriving", () => {
  const node = { ...LOCAL, localCommand: "pnpm dev", phases: null };
  assert.equal(runPhase(nodePhases(node))?.command, "pnpm dev");
});

test("malformed persisted phases fall back rather than blanking the node", () => {
  for (const bad of [
    [{ role: "nope", exec: "host", command: "x" }],
    [{ role: "run", exec: "elsewhere", command: "x" }],
    [{ role: "run", exec: "host", command: 42 }],
    ["not an object"],
    [],
    {},
    "[]",
  ]) {
    assert.equal(parsePhases(bad), null, `expected null for ${JSON.stringify(bad)}`);
    const node = { ...LOCAL, localCommand: "pnpm dev", phases: bad };
    assert.equal(runPhase(nodePhases(node))?.command, "pnpm dev");
  }
});

// --- Repeated roles: every reader takes all of them, not just the first ---

const repeated: StackPhase[] = [
  { role: "run", exec: "host", command: "pnpm dev:api" },
  { role: "run", exec: "host", command: "pnpm dev:web" },
];

test("every phase of a repeated role is returned, in order", () => {
  assert.deepEqual(commandsOf(repeated, "run"), ["pnpm dev:api", "pnpm dev:web"]);
  assert.equal(phasesWithRole(repeated, "run").length, 2);
  assert.equal(runPhases(repeated).length, 2);
});

test("runPhase still answers with the first, for single-answer callers", () => {
  // A sandbox has one preview port, not several.
  assert.equal(runPhase(repeated)?.command, "pnpm dev:api");
});

test("a phase with no command is not a runnable phase", () => {
  const phases: StackPhase[] = [
    { role: "run", exec: "host", command: null },
    { role: "run", exec: "host", command: "   " },
    { role: "run", exec: "host", command: "pnpm dev" },
  ];
  assert.deepEqual(runPhases(phases).map((p) => p.command), ["pnpm dev"]);
  assert.deepEqual(commandsOf(phases, "run"), ["pnpm dev"]);
});

test("repeated services phases all count as launchers", () => {
  const phases: StackPhase[] = [
    { role: "services", exec: "compose-extern", command: "make db-up" },
    { role: "services", exec: "compose-extern", command: "make queue-up" },
  ];
  assert.equal(servicePhases(phases).length, 2);
});

test("a repeated role collapses into one && sequence for the legacy column", () => {
  // One column cannot hold two commands. `&&` because a step whose predecessor
  // failed has nothing to run against.
  const columns = columnsOf(repeated);
  assert.equal(columns.localCommand, "pnpm dev:api && pnpm dev:web");
  assert.equal(columns.runMode, "local");
  assert.equal(columns.managesServices, false);
});

test("repeated installs collapse too, and keep the run phase separate", () => {
  const columns = columnsOf([
    { role: "install", exec: "host", command: "pnpm i" },
    { role: "install", exec: "host", command: "pip install -r req.txt" },
    { role: "run", exec: "host", command: "pnpm dev" },
  ]);
  assert.equal(columns.installCommand, "pnpm i && pip install -r req.txt");
  assert.equal(columns.localCommand, "pnpm dev");
});

test("parsing keeps the optional fields and drops unknown ones", () => {
  const parsed = parsePhases([
    {
      role: "services",
      exec: "compose-extern",
      command: "make up",
      composePath: "infra.yml",
      provides: ["db", 7],
      detached: true,
      workdir: "  ",
      bogus: "ignored",
    },
  ]);
  assert.deepEqual(parsed, [
    {
      role: "services",
      exec: "compose-extern",
      command: "make up",
      composePath: "infra.yml",
      provides: ["db"],
      detached: true,
      workdir: null,
    },
  ]);
});
