import { strict as assert } from "node:assert";
import { test } from "node:test";

import { findCycle, validateStack } from "./validate";
import type { StackNodeDTO } from "./types";

function node(over: Partial<StackNodeDTO> & { id: string; name: string }): StackNodeDTO {
  return {
    projectId: "p",
    kind: "repo",
    repositoryId: null,
    runMode: "local",
    image: null,
    dockerfile: null,
    buildContext: null,
    command: null,
    installCommand: null,
    buildCommand: null,
    localCommand: "pnpm dev",
    stopCommand: null,
    managesServices: false,
    workdir: null,
    ports: null,
    env: null,
    volumes: null,
    detection: null,
    phases: null,
    posX: 0,
    posY: 0,
    ...over,
  } as StackNodeDTO;
}

const rules = (r: ReturnType<typeof validateStack>) =>
  r.findings.map((f) => f.rule);

test("an empty canvas is an error, with somewhere to go next", () => {
  const res = validateStack({ nodes: [], edges: [] });
  assert.equal(res.ok, false);
  assert.deepEqual(rules(res), ["empty-canvas"]);
  // A validator that says "invalid" without saying what to do is a slower way
  // of reading the canvas yourself.
  assert.ok(res.findings[0].fix);
});

test("a healthy two-node stack passes clean", () => {
  const res = validateStack({
    nodes: [
      node({ id: "api", name: "api", ports: [{ host: 8000, container: 8000 }] }),
      node({
        id: "db",
        name: "postgres",
        kind: "service",
        runMode: "docker",
        image: "postgres:17",
        ports: [{ host: 5432, container: 5432 }],
      }),
    ],
    edges: [{ sourceId: "api", targetId: "db" }],
  });
  assert.equal(res.ok, true);
  assert.deepEqual(res.findings, []);
});

test("a cycle names the nodes in it, not just its existence", () => {
  // `generateCompose` already says "there is a cycle", which sends you looking
  // at every edge. Naming the three nodes is the difference from a fix.
  const res = validateStack({
    nodes: [
      node({ id: "a", name: "web" }),
      node({ id: "b", name: "api" }),
      node({ id: "c", name: "worker" }),
    ],
    edges: [
      { sourceId: "a", targetId: "b" },
      { sourceId: "b", targetId: "c" },
      { sourceId: "c", targetId: "a" },
    ],
  });
  assert.equal(res.ok, false);
  const cycle = res.findings.find((f) => f.rule === "dependency-cycle")!;
  for (const name of ["web", "api", "worker"]) {
    assert.match(cycle.message, new RegExp(name));
  }
});

test("findCycle returns the path and is null on a DAG", () => {
  assert.equal(
    findCycle([
      { sourceId: "a", targetId: "b" },
      { sourceId: "a", targetId: "c" },
      { sourceId: "b", targetId: "c" },
    ]),
    null,
  );
  const path = findCycle([
    { sourceId: "x", targetId: "y" },
    { sourceId: "y", targetId: "x" },
  ]);
  assert.ok(path && path.length >= 2);
});

test("a port published twice is an error, and is not resolved for you", () => {
  // Two apps defaulting to 3000 is the common monorepo case. Picking a port
  // for someone changes the URL they expect.
  const res = validateStack({
    nodes: [
      node({ id: "a", name: "web", ports: [{ host: 3000, container: 3000 }] }),
      node({ id: "b", name: "docs", ports: [{ host: 3000, container: 3000 }] }),
    ],
    edges: [],
  });
  assert.equal(res.ok, false);
  const collision = res.findings.find((f) => f.rule === "port-collision")!;
  assert.match(collision.message, /"web" and "docs"/);
  assert.match(collision.message, /3000/);
  assert.doesNotMatch(collision.fix ?? "", /\b3001\b/);
});

test("three nodes on one port are reported once, naming all of them", () => {
  const res = validateStack({
    nodes: ["a", "b", "c"].map((id) =>
      node({ id, name: id, ports: [{ host: 3000, container: 3000 }] }),
    ),
    edges: [],
  });
  assert.equal(res.findings.filter((f) => f.rule === "port-collision").length, 1);
});

test("a service with no image cannot start", () => {
  const res = validateStack({
    nodes: [node({ id: "s", name: "cache", kind: "service", runMode: "docker" })],
    edges: [],
  });
  assert.equal(res.ok, false);
  assert.ok(rules(res).includes("service-without-image"));
});

test("an untagged image is a warning, not an error", () => {
  const res = validateStack({
    nodes: [
      node({
        id: "s",
        name: "cache",
        kind: "service",
        runMode: "docker",
        image: "redis",
      }),
    ],
    edges: [],
  });
  // It works today and will keep working — until :latest moves under it.
  assert.equal(res.ok, true);
  assert.ok(rules(res).includes("untagged-image"));
});

test("a docker repo with nothing to build is an error", () => {
  const res = validateStack({
    nodes: [node({ id: "a", name: "api", runMode: "docker" })],
    edges: [],
  });
  assert.equal(res.ok, false);
  assert.ok(rules(res).includes("docker-repo-without-build"));
});

test("a dependency nothing can probe warns only when something depends on it", () => {
  // The race piece 2 removed for known images: a dependent installs against a
  // database that is running but not yet accepting connections.
  const withDependent = validateStack({
    nodes: [
      node({ id: "a", name: "api" }),
      node({
        id: "x",
        name: "custom-db",
        kind: "service",
        runMode: "docker",
        image: "acme/db:1",
      }),
    ],
    edges: [{ sourceId: "a", targetId: "x" }],
  });
  assert.ok(rules(withDependent).includes("unprobeable-dependency"));

  // Alone on the canvas, nothing can race it — so saying anything is noise.
  const alone = validateStack({
    nodes: [
      node({
        id: "x",
        name: "custom-db",
        kind: "service",
        runMode: "docker",
        image: "acme/db:1",
      }),
    ],
    edges: [],
  });
  assert.ok(!rules(alone).includes("unprobeable-dependency"));
});

test("a recognized image is never reported as unprobeable", () => {
  const res = validateStack({
    nodes: [
      node({ id: "a", name: "api" }),
      node({
        id: "db",
        name: "postgres",
        kind: "service",
        runMode: "docker",
        image: "postgres:17",
      }),
    ],
    edges: [{ sourceId: "a", targetId: "db" }],
  });
  assert.ok(!rules(res).includes("unprobeable-dependency"));
});

test("a placeholder env value is caught before it reaches a .env", () => {
  const res = validateStack({
    nodes: [
      node({
        id: "a",
        name: "api",
        env: [
          { key: "DATABASE_URL", value: "postgres://localhost/app" },
          { key: "STRIPE_KEY", value: "CHANGEME" },
          { key: "SENTRY_DSN", value: "<your-dsn>" },
          { key: "EMPTY", value: "" },
        ],
      }),
    ],
    edges: [],
  });
  const placeholders = res.findings.filter((f) => f.rule === "placeholder-env");
  assert.equal(placeholders.length, 3);
  // A real value is left alone.
  assert.ok(!placeholders.some((f) => f.message.includes("DATABASE_URL")));
  // An empty value is weaker evidence than CHANGEME, and is graded as such.
  assert.equal(
    placeholders.find((f) => f.message.includes("EMPTY"))!.severity,
    "info",
  );
  assert.equal(res.ok, true);
});

test("a repo with no run command is information, not a failure", () => {
  // It may be a library another node builds.
  const res = validateStack({
    nodes: [node({ id: "lib", name: "shared", localCommand: null })],
    edges: [],
  });
  assert.equal(res.ok, true);
  assert.equal(
    res.findings.find((f) => f.rule === "no-run-command")!.severity,
    "info",
  );
});

test("a missing local checkout is a warning about Up, not about the definition", () => {
  const res = validateStack({
    nodes: [node({ id: "a", name: "api", repositoryId: "r1" })],
    edges: [],
    repoHasLocalPath: new Map([["r1", false]]),
  });
  assert.equal(res.ok, true);
  const f = res.findings.find((f) => f.rule === "repo-without-local-path")!;
  assert.match(f.fix ?? "", /sandbox clones it/);
});

test("an edge to a deleted node is reported once", () => {
  const res = validateStack({
    nodes: [node({ id: "a", name: "api" })],
    edges: [
      { sourceId: "a", targetId: "gone" },
      { sourceId: "a", targetId: "also-gone" },
    ],
  });
  assert.equal(rules(res).filter((r) => r === "dangling-edge").length, 1);
});

test("every finding carries the node it is about, when it is about one", () => {
  const res = validateStack({
    nodes: [
      node({ id: "s", name: "cache", kind: "service", runMode: "docker" }),
      node({ id: "a", name: "api", runMode: "docker" }),
    ],
    edges: [],
  });
  for (const f of res.findings) {
    if (f.rule === "dependency-cycle" || f.rule === "empty-canvas") continue;
    assert.ok(f.nodeId, `${f.rule} has no nodeId`);
    assert.ok(f.nodeName, `${f.rule} has no nodeName`);
  }
});
