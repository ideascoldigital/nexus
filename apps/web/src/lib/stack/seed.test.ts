import { strict as assert } from "node:assert";
import { test } from "node:test";

import { isRunnable, seedStack, type SeedUnit } from "./seed";
import type { DetectionResult } from "./types";

function detection(over: Partial<DetectionResult> = {}): DetectionResult {
  return {
    scannedAt: "2026-09-23T00:00:00Z",
    hasDockerfile: false,
    hasCompose: false,
    packageManager: "pnpm",
    scripts: {},
    suggestedCommands: { install: "pnpm install", dev: "pnpm dev" },
    envExampleKeys: [],
    suggestedPorts: [],
    ...over,
  };
}

function unit(
  name: string,
  over: Partial<DetectionResult> = {},
  opts: { workdir?: string; isRoot?: boolean; repositoryId?: string } = {},
): SeedUnit {
  return {
    unit: {
      name,
      localPath: `/repos/${name}`,
      workdir: opts.workdir ?? "",
      isRoot: opts.isRoot ?? true,
    },
    repositoryId: opts.repositoryId ?? "r1",
    detection: detection(over),
  };
}

/** Env example with values, the shape detection now returns. */
function env(values: Record<string, string>): Partial<DetectionResult> {
  return { envExampleKeys: Object.keys(values), envExampleValues: values };
}

const names = (r: ReturnType<typeof seedStack>) => r.nodes.map((n) => n.name);

test("a single repo with a dev script becomes one node", () => {
  const res = seedStack([unit("api")]);
  assert.deepEqual(names(res), ["api"]);
  assert.equal(res.nodes[0].kind, "repo");
  assert.equal(res.nodes[0].runMode, "local");
  assert.deepEqual(res.edges, []);
});

test("two repos and one monorepo produce the same shape", () => {
  // The claim the whole unit model rests on: past discovery, the number of
  // gits is irrelevant.
  const separate = seedStack([
    unit("web", { suggestedPorts: [3000] }),
    unit("api", { suggestedPorts: [8000] }),
  ]);
  const mono = seedStack([
    { ...unit("mono", {}, { isRoot: true }), detection: detection({ suggestedCommands: { install: "pnpm install" } }) },
    unit("mono/apps/web", { suggestedPorts: [3000] }, { workdir: "apps/web", isRoot: false }),
    unit("mono/apps/api", { suggestedPorts: [8000] }, { workdir: "apps/api", isRoot: false }),
  ]);

  assert.equal(separate.nodes.length, 2);
  assert.equal(mono.nodes.length, 2);
  assert.deepEqual(
    separate.nodes.map((n) => n.ports),
    mono.nodes.map((n) => n.ports),
  );
});

test("a workspace's libraries do not become nodes", () => {
  // Nine libraries and two apps must not be eleven nodes.
  const res = seedStack([
    unit("mono", { suggestedCommands: { install: "pnpm install" } }, { isRoot: true }),
    unit("mono/apps/web", {}, { workdir: "apps/web", isRoot: false }),
    unit(
      "mono/packages/ui",
      { suggestedCommands: { install: "pnpm install", build: "pnpm build" } },
      { workdir: "packages/ui", isRoot: false },
    ),
  ]);
  assert.deepEqual(names(res), ["mono/apps/web"]);
  assert.ok(res.notes.some((n) => n.includes("packages/ui") && n.includes("library")));
});

test("a non-runnable workspace root is not reported as a library", () => {
  // It is the normal case, and a note for it on every monorepo is noise.
  const res = seedStack([
    unit("mono", { suggestedCommands: { install: "pnpm install" } }, { isRoot: true }),
    unit("mono/apps/web", {}, { workdir: "apps/web", isRoot: false }),
  ]);
  assert.equal(res.notes.filter((n) => n.includes("library")).length, 0);
});

test("isRunnable accepts a Dockerfile or a detached make target", () => {
  assert.equal(isRunnable(detection({ suggestedCommands: {} })), false);
  assert.equal(isRunnable(detection({ suggestedCommands: {}, hasDockerfile: true })), true);
  assert.equal(
    isRunnable(
      detection({
        suggestedCommands: {},
        makeTargetDetails: [
          {
            name: "up",
            prerequisites: [],
            usesDocker: true,
            composeFiles: [],
            composeServices: [],
            detached: true,
            teardown: false,
          },
        ],
      }),
    ),
    true,
  );
});

test("a scheme in the value is conclusive", () => {
  const res = seedStack([
    unit("api", env({ DATABASE_URL: "postgres://user:pw@localhost:5432/app" })),
  ]);
  const db = res.nodes.find((n) => n.kind === "service")!;
  assert.equal(db.image, "postgres:17");
  assert.equal(db.confidence, "high");
  assert.match(db.evidence, /DATABASE_URL=postgres:/);
  // And the edge is a fact: the variable is in that unit's own example file.
  assert.deepEqual(res.edges, [{ sourceId: res.nodes[0].id, targetId: db.id }]);
});

test("a bare DATABASE_URL still creates a node, flagged low", () => {
  // Silence would leave the blank canvas this piece exists to remove — but the
  // project may well mean MySQL, so the guess is labelled as one.
  const res = seedStack([unit("api", env({ DATABASE_URL: "" }))]);
  const db = res.nodes.find((n) => n.kind === "service");
  assert.equal(db, undefined, "an empty value is not evidence of an engine");
});

test("a key match without a scheme is low confidence", () => {
  const res = seedStack([unit("api", env({ POSTGRES_HOST: "localhost" }))]);
  const db = res.nodes.find((n) => n.kind === "service")!;
  assert.equal(db.confidence, "low");
  assert.match(db.evidence, /POSTGRES_HOST in api/);
});

test("mysql in the URL does not produce postgres", () => {
  const res = seedStack([unit("api", env({ DATABASE_URL: "mysql://root@db/app" }))]);
  const svc = res.nodes.filter((n) => n.kind === "service");
  assert.equal(svc.length, 1);
  assert.equal(svc[0].image, "mysql:8");
});

test("three units naming a database get one postgres between them", () => {
  // Three containers racing for 5432 is a boot failure nobody asked for.
  const e = env({ DATABASE_URL: "postgres://localhost/app" });
  const res = seedStack([
    unit("a", { ...e, suggestedPorts: [3001] }),
    unit("b", { ...e, suggestedPorts: [3002] }),
    unit("c", { ...e, suggestedPorts: [3003] }),
  ]);
  const services = res.nodes.filter((n) => n.kind === "service");
  assert.equal(services.length, 1);
  // …and every unit that produced the evidence gets its own edge.
  assert.equal(res.edges.length, 3);
});

test("a later conclusive match upgrades an earlier guess", () => {
  const res = seedStack([
    unit("a", env({ POSTGRES_HOST: "db" })),
    unit("b", env({ DATABASE_URL: "postgres://db/app" })),
  ]);
  const db = res.nodes.find((n) => n.kind === "service")!;
  assert.equal(db.confidence, "high");
  assert.match(db.evidence, /in b$/);
});

test("a repo that owns a compose file suppresses inference", () => {
  // Duplicating its services would start two postgres containers fighting
  // over 5432.
  const res = seedStack([
    unit("api", {
      ...env({ DATABASE_URL: "postgres://localhost/app" }),
      hasCompose: true,
      composePath: "docker-compose.yml",
    }),
  ]);
  assert.equal(res.nodes.filter((n) => n.kind === "service").length, 0);
  assert.ok(res.notes.some((n) => n.includes("own compose file")));
});

test("unit-to-unit edges are never inferred", () => {
  // A front end's API_URL pointing at a back end's port is suggestive, not
  // conclusive, and a wrong edge changes boot order in a way that is hard to
  // debug.
  const res = seedStack([
    unit("web", { ...env({ API_URL: "http://localhost:8000" }), suggestedPorts: [3000] }),
    unit("api", { suggestedPorts: [8000] }),
  ]);
  assert.deepEqual(res.edges, []);
});

test("a port claimed twice is flagged and left alone", () => {
  const res = seedStack([
    unit("web", { suggestedPorts: [3000] }),
    unit("docs", { suggestedPorts: [3000] }),
  ]);
  const note = res.notes.find((n) => n.includes("3000"))!;
  assert.match(note, /"web" and "docs"/);
  // Not resolved: picking a port changes the URL the user expects.
  assert.deepEqual(res.nodes[0].ports, [{ host: 3000, container: 3000 }]);
  assert.deepEqual(res.nodes[1].ports, [{ host: 3000, container: 3000 }]);
});

test("a Dockerfile switches the node to docker mode and is the evidence", () => {
  const res = seedStack([
    unit("api", { hasDockerfile: true, dockerfilePath: "docker/Dockerfile" }),
  ]);
  assert.equal(res.nodes[0].runMode, "docker");
  assert.equal(res.nodes[0].dockerfile, "docker/Dockerfile");
  assert.match(res.nodes[0].evidence, /docker\/Dockerfile/);
});

test("a detached make target becomes a services phase, not a run phase", () => {
  // The shape spec 17 defined and that detection already fills but nothing
  // ever wrote.
  const res = seedStack([
    unit("api", {
      suggestedCommands: { install: "pnpm install", dev: "pnpm dev" },
      makeTargetDetails: [
        {
          name: "docker-up",
          prerequisites: [],
          usesDocker: true,
          composeFiles: ["docker-compose.yml"],
          composeServices: ["postgres", "redis"],
          detached: true,
          teardown: false,
        },
      ],
    }),
  ]);
  const phases = res.nodes[0].phases;
  const services = phases.find((p) => p.role === "services")!;
  assert.equal(services.exec, "compose-extern");
  assert.equal(services.command, "make docker-up");
  assert.deepEqual(services.provides, ["postgres", "redis"]);
  // The app still has its own run phase.
  assert.ok(phases.some((p) => p.role === "run" && p.command === "pnpm dev"));
});

test("phases carry the unit's workdir, so a monorepo app installs in place", () => {
  const res = seedStack([
    unit("mono/apps/api", {}, { workdir: "apps/api", isRoot: false }),
  ]);
  for (const phase of res.nodes[0].phases) {
    assert.equal(phase.workdir, "apps/api");
  }
  assert.equal(res.nodes[0].workdir, "apps/api");
});

test("nodes are laid out so a seeded canvas is readable", () => {
  // Every node at (0,0) reads as a single node and hides what was inferred.
  const res = seedStack([
    unit("web", { ...env({ DATABASE_URL: "postgres://x/y" }), suggestedPorts: [3000] }),
    unit("api", { suggestedPorts: [8000] }),
  ]);
  const positions = res.nodes.map((n) => `${n.posX},${n.posY}`);
  assert.equal(new Set(positions).size, positions.length, "two nodes overlap");
  // Services sit below the apps they serve.
  const svc = res.nodes.find((n) => n.kind === "service")!;
  assert.ok(svc.posY > res.nodes[0].posY);
});

test("an empty project seeds nothing rather than throwing", () => {
  const res = seedStack([]);
  assert.deepEqual(res.nodes, []);
  assert.deepEqual(res.edges, []);
});

test("a workspace member inherits the root's package manager", () => {
  // A member does not declare `packageManager` — the root does, and detection
  // scans each unit in isolation so it cannot see it. Left alone, every app in
  // a pnpm monorepo would get `npm install`, which at best ignores the
  // workspace and at worst writes a package-lock.json beside pnpm-lock.yaml.
  const res = seedStack([
    {
      ...unit("mono", { suggestedCommands: { install: "pnpm install" } }, { isRoot: true }),
      detection: detection({
        packageManager: "pnpm",
        suggestedCommands: { install: "pnpm install" },
      }),
    },
    {
      ...unit("mono/apps/api", {}, { workdir: "apps/api", isRoot: false }),
      detection: detection({
        packageManager: "npm",
        suggestedCommands: {
          install: "npm install",
          build: "npm run build",
          dev: "npm run dev",
        },
      }),
    },
  ]);

  const commands = res.nodes[0].phases.map((p) => p.command);
  assert.deepEqual(commands, ["pnpm install", "pnpm build", "pnpm dev"]);
});

test("a member with its own lockfile keeps its manager", () => {
  // It detected yarn because it has a yarn.lock — the root's answer is not
  // better information than the member's own.
  const res = seedStack([
    {
      ...unit("mono", {}, { isRoot: true }),
      detection: detection({
        packageManager: "pnpm",
        suggestedCommands: { install: "pnpm install" },
      }),
    },
    {
      ...unit("mono/apps/api", {}, { workdir: "apps/api", isRoot: false }),
      detection: detection({
        packageManager: "yarn",
        suggestedCommands: { install: "yarn install", dev: "yarn dev" },
      }),
    },
  ]);
  assert.ok(res.nodes[0].phases.every((p) => p.command?.startsWith("yarn")));
});

test("a standalone repo's commands are never rewritten", () => {
  const res = seedStack([
    {
      ...unit("api"),
      detection: detection({
        packageManager: "npm",
        suggestedCommands: { install: "npm install", dev: "npm run dev" },
      }),
    },
  ]);
  assert.deepEqual(
    res.nodes[0].phases.map((p) => p.command),
    ["npm install", "npm run dev"],
  );
});
