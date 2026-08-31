import assert from "node:assert/strict";
import fs from "node:fs";
import { after, test } from "node:test";

// Env setup must stay above ./sandbox-processes — it reaches prisma at import
// time and the client is built when the module loads.
import { testDbDir } from "./sandbox-processes.test-setup";
import {
  buildProcessPlans,
  type ProcessNodeSource,
  type ProcessRepoSource,
} from "./sandbox-processes";

// The rule under test is pure (see buildProcessPlans): no prisma, and the
// package.json lookup is injected, so nothing here touches disk.
const noScripts = async () => null;

after(() => {
  fs.rmSync(testDbDir, { recursive: true, force: true });
});

const node = (over: Partial<ProcessNodeSource> = {}): ProcessNodeSource => ({
  id: "node-web",
  name: "web",
  kind: "repo",
  runMode: "local",
  localCommand: "pnpm dev",
  managesServices: false,
  workdir: null,
  ports: null,
  phases: null,
  repository: { id: "repo-web", name: "web", localPath: "/src/web" },
  ...over,
});

const repo = (over: Partial<ProcessRepoSource> = {}): ProcessRepoSource => ({
  id: "repo-web",
  name: "web",
  localPath: "/src/web",
  setup: null,
  ...over,
});

test("every repo with a run phase becomes its own process", async () => {
  // The bug this feature exists for: two repos on the canvas, only the main one
  // was ever startable.
  const plans = await buildProcessPlans(
    [
      node(),
      node({
        id: "node-fn",
        name: "functions",
        localCommand: "pnpm serve",
        repository: { id: "repo-fn", name: "functions", localPath: "/src/fn" },
      }),
    ],
    [repo(), repo({ id: "repo-fn", name: "functions", localPath: "/src/fn" })],
    noScripts,
  );

  assert.deepEqual(
    plans.map((p) => [p.key, p.label, p.command]),
    [
      ["node-web#0", "web", "pnpm dev"],
      ["node-fn#0", "functions", "pnpm serve"],
    ],
  );
});

test("a repo's remote cwd is its checkout, plus any workdir", async () => {
  const plans = await buildProcessPlans(
    [node({ name: "My App", repository: { id: "repo-web", name: "My App", localPath: "/src/web" }, workdir: "./packages/api" })],
    [repo({ name: "My App" })],
    noScripts,
  );

  assert.equal(plans[0].cwd, "/opt/nexus/my-app/packages/api");
});

test("a launcher's services phase is startable, and declares no port", async () => {
  // Firebase emulators come up via a launcher; after a pause/resume nothing
  // else brings them back, so it needs a start button of its own.
  const plans = await buildProcessPlans(
    [
      node({
        id: "node-fn",
        name: "emulators",
        localCommand: "firebase emulators:start",
        managesServices: true,
        ports: [{ host: 4000, container: 4000 }],
        repository: { id: "repo-fn", name: "functions", localPath: "/src/fn" },
      }),
    ],
    [repo({ id: "repo-fn", name: "functions", localPath: "/src/fn" })],
    noScripts,
  );

  assert.equal(plans.length, 1);
  assert.equal(plans[0].role, "services");
  // Probing a port would only time out: the command exits once its containers
  // are up.
  assert.equal(plans[0].port, null);
  // …but the declared ports survive in checkPorts — they are how liveness can
  // still see the containers after the launcher's shell exits.
  assert.deepEqual(plans[0].checkPorts, [4000]);
});

test("a node with two run phases yields two numbered processes", async () => {
  const plans = await buildProcessPlans(
    [
      node({
        phases: [
          { role: "run", exec: "host", command: "pnpm dev" },
          { role: "run", exec: "host", command: "pnpm dev:worker" },
        ],
      }),
    ],
    [repo()],
    noScripts,
  );

  assert.deepEqual(
    plans.map((p) => [p.key, p.label]),
    [
      ["node-web#0", "web (1)"],
      ["node-web#1", "web (2)"],
    ],
  );
});

test("declared ports go to the first run phase only", async () => {
  // Two servers from one checkout must not both advertise the node's port.
  const plans = await buildProcessPlans(
    [
      node({
        ports: [{ host: 3000, container: 3000 }],
        phases: [
          { role: "run", exec: "host", command: "pnpm dev" },
          { role: "run", exec: "host", command: "pnpm dev:worker" },
        ],
      }),
    ],
    [repo()],
    noScripts,
  );

  assert.equal(plans[0].port, 3000);
  assert.equal(plans[1].port, null);
});

test("a port named in the command wins over nothing declared", async () => {
  const plans = await buildProcessPlans(
    [node({ localCommand: "next dev --port 3003" })],
    [repo()],
    noScripts,
  );

  assert.equal(plans[0].port, 3003);
});

test("a port hidden in the repo's script is resolved through the host", async () => {
  const plans = await buildProcessPlans(
    [node({ localCommand: "pnpm dev" })],
    [repo()],
    async () => "next dev --port 4100",
  );

  assert.equal(plans[0].port, 4100);
});

test("a repo with no canvas node falls back to its setup run command", async () => {
  const plans = await buildProcessPlans(
    [],
    [repo({ setup: { runCommand: "pnpm start" } })],
    noScripts,
  );

  assert.deepEqual(
    plans.map((p) => [p.key, p.command, p.source]),
    [["repo-repo-web", "pnpm start", "repo-setup"]],
  );
});

test("a repo on the canvas does not also get a setup fallback plan", async () => {
  // Otherwise the same dev server appears twice, with two different keys.
  const plans = await buildProcessPlans(
    [node()],
    [repo({ setup: { runCommand: "pnpm start" } })],
    noScripts,
  );

  assert.equal(plans.length, 1);
  assert.equal(plans[0].source, "stack");
});

test("docker nodes and node-less repos produce nothing to start", async () => {
  const plans = await buildProcessPlans(
    [
      // Compose owns docker nodes end to end.
      node({ runMode: "docker", command: "postgres" }),
      // A bare local node has no checkout to run in.
      node({ id: "node-bare", repository: null }),
    ],
    [repo({ setup: { runCommand: null } })],
    noScripts,
  );

  assert.deepEqual(plans, []);
});
