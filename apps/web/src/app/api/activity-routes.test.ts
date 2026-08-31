import assert from "node:assert/strict";
import fs from "node:fs";
import { after, before, beforeEach, test } from "node:test";

// Env setup must stay above every other import — the route modules reach
// @nexux/db, whose client is built (and migrated) at module load.
import { testDbDir } from "./routes.test-setup";
import { NextRequest } from "next/server";
import { prisma } from "@nexux/db";

import { GET as getActivity } from "./activity/route";

let projectId: string;
let sandboxId: string;
let otherWorkspaceSandboxId: string;

before(async () => {
  // "ws-default" is seeded by the migrations and is what getActiveWorkspaceId
  // answers with no cookie — upsert rather than create, and hang the project
  // off it so the route sees these rows as the active workspace's.
  const [ws, other] = await Promise.all([
    prisma.workspace.upsert({
      where: { id: "ws-default" },
      update: {},
      create: { id: "ws-default", name: "Mine" },
    }),
    prisma.workspace.upsert({
      where: { id: "ws-activity-theirs" },
      update: {},
      create: { id: "ws-activity-theirs", name: "Theirs" },
    }),
  ]);
  const [project, foreign] = await Promise.all([
    prisma.project.create({ data: { name: "Main", workspaceId: ws.id } }),
    prisma.project.create({ data: { name: "Foreign", workspaceId: other.id } }),
  ]);
  projectId = project.id;
  const [box, foreignBox] = await Promise.all([
    prisma.sandbox.create({
      data: {
        projectId,
        name: "box",
        provider: "local",
        region: "lon1",
        size: "small",
        workDir: "/tmp/box",
        status: "running",
      },
    }),
    prisma.sandbox.create({
      data: {
        projectId: foreign.id,
        name: "theirs",
        provider: "local",
        region: "lon1",
        size: "small",
        workDir: "/tmp/theirs",
        status: "running",
      },
    }),
  ]);
  sandboxId = box.id;
  otherWorkspaceSandboxId = foreignBox.id;
  // The route resolves the active workspace from a cookie, which does not
  // exist outside a request. This is the override the other route tests use.
  process.env.NEXUX_TEST_WORKSPACE = ws.id;
});

after(async () => {
  delete process.env.NEXUX_TEST_WORKSPACE;
  await prisma.$disconnect();
  fs.rmSync(testDbDir, { recursive: true, force: true });
});

beforeEach(async () => {
  await prisma.sandboxTask.deleteMany({});
});

const seed = (over: Partial<Record<string, unknown>> = {}) => ({
  sandboxId,
  prompt: "do the thing",
  workDir: "/opt/nexus/app",
  kind: "task",
  status: "running",
  ...over,
});

type Body = {
  active: { id: string; needsInput: boolean; sandboxId: string }[];
  recent: { id: string; finishedAt: string | null }[];
  idleSandboxes: { id: string; name: string }[];
};

const get = async () => {
  const res = await getActivity(new NextRequest("http://test/api/activity"));
  assert.equal(res.status, 200);
  return (await res.json()) as Body;
};

test("a blocked run is flagged, a plain running one is not", async () => {
  await prisma.sandboxTask.create({
    data: seed({ phase: "needs_input", prompt: "which db?" }),
  });
  await prisma.sandboxTask.create({ data: seed({ phase: "agent" }) });
  const body = await get();
  assert.equal(body.active.length, 2);
  assert.equal(body.active.filter((t) => t.needsInput).length, 1);
});

test("blocked runs sort ahead of freshly started ones", async () => {
  // Oldest first on purpose: something waiting on an answer is what you open,
  // and sorting by recency buries it under whatever started last.
  const old = await prisma.sandboxTask.create({
    data: seed({ phase: "needs_input", prompt: "waiting" }),
  });
  await new Promise((r) => setTimeout(r, 10));
  await prisma.sandboxTask.create({ data: seed({ prompt: "just started" }) });
  const body = await get();
  assert.equal(body.active[0].id, old.id);
});

test("queued runs are active too, not pending nothing", async () => {
  await prisma.sandboxTask.create({ data: seed({ status: "queued" }) });
  assert.equal((await get()).active.length, 1);
});

test("finished runs land in recent, not active", async () => {
  await prisma.sandboxTask.create({
    data: seed({ status: "completed", finishedAt: new Date() }),
  });
  await prisma.sandboxTask.create({
    data: seed({ status: "error", finishedAt: new Date() }),
  });
  const body = await get();
  assert.equal(body.active.length, 0);
  assert.equal(body.recent.length, 2);
});

test("a sandbox running a task is not also offered as idle", async () => {
  await prisma.sandboxTask.create({ data: seed() });
  const body = await get();
  assert.equal(body.idleSandboxes.length, 0, "it is already in active");
});

test("a sandbox with nothing running is offered", async () => {
  const body = await get();
  assert.deepEqual(body.idleSandboxes.map((s) => s.name), ["box"]);
});

test("another workspace's sandboxes and runs stay out", async () => {
  await prisma.sandboxTask.create({
    data: seed({ sandboxId: otherWorkspaceSandboxId }),
  });
  const body = await get();
  assert.equal(body.active.length, 0);
  assert.ok(
    !body.idleSandboxes.some((s) => s.name === "theirs"),
    "foreign sandbox is not listed",
  );
});

test("an empty workspace answers with empty lists, not an error", async () => {
  const body = await get();
  assert.deepEqual(body.active, []);
  assert.deepEqual(body.recent, []);
});
