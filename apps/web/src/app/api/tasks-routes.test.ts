import assert from "node:assert/strict";
import fs from "node:fs";
import { after, before, beforeEach, test } from "node:test";

// Env setup must stay above every other import — the route modules reach
// @nexux/db, whose client is built (and migrated) at module load.
import { testDbDir } from "./routes.test-setup";
import { NextRequest } from "next/server";
import { prisma } from "@nexux/db";

import { recoverOrphanTasks, releaseSandboxLock } from "@/lib/task-manager";
import {
  GET as listTasks,
  POST as createTask,
} from "./projects/[projectId]/tasks/route";

let projectId: string;
let otherProjectId: string;
let sandboxId: string;

before(async () => {
  const workspace = await prisma.workspace.create({
    data: { id: "ws-tasks-test", name: "Tasks" },
  });
  const [project, other] = await Promise.all([
    prisma.project.create({ data: { name: "Main", workspaceId: workspace.id } }),
    prisma.project.create({ data: { name: "Other", workspaceId: workspace.id } }),
  ]);
  projectId = project.id;
  otherProjectId = other.id;
  const sandbox = await prisma.sandbox.create({
    data: {
      projectId,
      name: "sbx-1",
      status: "running",
      provider: "local",
      region: "lon1",
      size: "small",
      workDir: "/tmp/sbx-1",
      // A local sandbox is only reachable once it has a container.
      instanceId: "container-1",
    },
  });
  sandboxId = sandbox.id;
});

after(async () => {
  // Dispatched tasks fire background teardown that outlives the test; give it
  // a tick to settle so it does not log against a deleted database.
  await new Promise((resolve) => setTimeout(resolve, 250));
  await prisma.$disconnect();
  fs.rmSync(testDbDir, { recursive: true, force: true });
});

beforeEach(async () => {
  await prisma.sandboxTask.deleteMany({});
  await prisma.feature.deleteMany({});
  // The one-task-per-sandbox lock lives in memory, so deleting the rows does
  // not free it — a dispatched task would otherwise block every later test.
  releaseSandboxLock(sandboxId);
});

/** Seed a task row directly; workDir is required by the schema. */
const seedTask = (over: {
  sandboxId?: string;
  prompt: string;
  kind?: string;
  featureId?: string;
  log?: string;
}) => ({
  sandboxId: over.sandboxId ?? sandboxId,
  prompt: over.prompt,
  status: "queued",
  kind: over.kind ?? "task",
  workDir: "/opt/nexus/app",
  ...(over.featureId ? { featureId: over.featureId } : {}),
  ...(over.log ? { log: over.log } : {}),
});

const post = (body: unknown, id = projectId) =>
  createTask(
    new NextRequest("http://test/api/tasks", {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
    }),
    { params: Promise.resolve({ projectId: id }) }
  );

const list = (query = "", id = projectId) =>
  listTasks(new NextRequest(`http://test/api/tasks${query}`), {
    params: Promise.resolve({ projectId: id }),
  });

/** The four cross-field rules the create schema enforces. */
const formErrors = async (res: Response) => {
  const body = (await res.json()) as { error: { formErrors: string[] } };
  return body.error.formErrors;
};

// --- POST validation --------------------------------------------------------

test("a task needs somewhere to run", async () => {
  // Neither an existing sandbox nor a launch request.
  const res = await post({ prompt: "do the thing" });
  assert.equal(res.status, 400);
  assert.ok(
    (await formErrors(res)).some((e) => /sandboxId or launch/.test(e))
  );
});

test("a task needs something to do", async () => {
  const res = await post({ sandboxId });
  assert.equal(res.status, 400);
  assert.ok(
    (await formErrors(res)).some((e) => /featureId, prompt or followUpOf/.test(e))
  );
});

test("a whitespace-only prompt does not count as work", async () => {
  const res = await post({ sandboxId, prompt: "   " });
  assert.equal(res.status, 400);
});

test("a follow-up needs a prompt of its own", async () => {
  const res = await post({ sandboxId, followUpOf: "task-1" });
  assert.equal(res.status, 400);
  assert.ok((await formErrors(res)).some((e) => /follow-up needs a prompt/.test(e)));
});

test("a follow-up cannot launch a fresh sandbox", async () => {
  // Follow-ups continue a session that lives on one specific sandbox.
  const res = await post({ launch: true, followUpOf: "task-1", prompt: "more" });
  assert.equal(res.status, 400);
  assert.ok(
    (await formErrors(res)).some((e) => /sandbox that owns the session/.test(e))
  );
});

test("an empty sandboxId is not a sandbox", async () => {
  assert.equal((await post({ sandboxId: "", prompt: "x" })).status, 400);
});

// --- POST behaviour ---------------------------------------------------------

test("a feature from another project is refused", async () => {
  // Otherwise a task could be filed against work this project does not own.
  const feature = await prisma.feature.create({
    data: { projectId: otherProjectId, title: "Theirs" },
  });
  const res = await post({ sandboxId, featureId: feature.id });
  assert.equal(res.status, 400);
  const body = (await res.json()) as { error: string };
  assert.match(body.error, /Feature not found in this project/);
});

test("a feature id that does not exist is refused", async () => {
  const res = await post({ sandboxId, featureId: "no-such-feature" });
  assert.equal(res.status, 400);
});

test("a task for this project's feature is accepted", async () => {
  const feature = await prisma.feature.create({
    data: { projectId, title: "Add login", description: "build it" },
  });
  const res = await post({ sandboxId, featureId: feature.id });
  assert.equal(res.status, 202);
  const stored = await prisma.sandboxTask.findFirst({ where: { sandboxId } });
  assert.equal(stored?.featureId, feature.id);
  assert.ok(stored?.prompt.includes("Add login"));
});

test("an explicit prompt overrides the feature-derived one", async () => {
  const feature = await prisma.feature.create({
    data: { projectId, title: "Add login" },
  });
  const res = await post({ sandboxId, featureId: feature.id, prompt: "just do X" });
  assert.equal(res.status, 202);
  const stored = await prisma.sandboxTask.findFirst({ where: { sandboxId } });
  assert.equal(stored?.prompt, "just do X");
});

test("a plain prompt task is accepted without a feature", async () => {
  const res = await post({ sandboxId, prompt: "run the tests" });
  assert.equal(res.status, 202);
  const stored = await prisma.sandboxTask.findFirst({ where: { sandboxId } });
  assert.equal(stored?.prompt, "run the tests");
  assert.equal(stored?.featureId, null);
});

test("a sandbox already running a task refuses a second one", async () => {
  // One task per sandbox: two agents in the same checkout would fight over
  // the working tree.
  assert.equal((await post({ sandboxId, prompt: "first" })).status, 202);
  const second = await post({ sandboxId, prompt: "second" });
  assert.equal(second.status, 400);
  const body = (await second.json()) as { error: string };
  assert.match(body.error, /already running a task/);
});

test("a local sandbox with no container is not dispatchable", async () => {
  // status alone is not enough: a local sandbox needs its container id, or
  // the task would be sent nowhere.
  const containerless = await prisma.sandbox.create({
    data: {
      projectId,
      name: "sbx-no-container",
      status: "running",
      provider: "local",
      region: "lon1",
      size: "small",
      workDir: "/tmp/x",
    },
  });
  const res = await post({ sandboxId: containerless.id, prompt: "x" });
  assert.equal(res.status, 400);
  const body = (await res.json()) as { error: string };
  assert.match(body.error, /not running/i);
});

test("a sandbox that does not exist is reported as a 400", async () => {
  // createTask throws; the handler turns that into a client error rather
  // than a 500.
  const res = await post({ sandboxId: "no-such-sandbox", prompt: "x" });
  assert.equal(res.status, 400);
  const body = (await res.json()) as { error: string };
  assert.equal(typeof body.error, "string");
});

// --- GET --------------------------------------------------------------------

test("the task list is scoped to this project's sandboxes", async () => {
  const otherSandbox = await prisma.sandbox.create({
    data: {
      projectId: otherProjectId,
      name: "sbx-other",
      status: "running",
      provider: "local",
      region: "lon1",
      size: "small",
      workDir: "/tmp/sbx-other",
    },
  });
  await prisma.sandboxTask.createMany({
    data: [
      seedTask({ prompt: "mine" }),
      seedTask({ sandboxId: otherSandbox.id, prompt: "theirs" }),
    ],
  });
  const res = await list();
  assert.equal(res.status, 200);
  const tasks = (await res.json()) as { prompt: string }[];
  assert.deepEqual(
    tasks.map((t) => t.prompt),
    ["mine"]
  );
});

test("the global list hides dev-console prompts", async () => {
  // Dev runs belong to the chat feed, not the task history.
  await prisma.sandboxTask.createMany({
    data: [
      seedTask({ prompt: "a task" }),
      seedTask({ prompt: "a dev prompt", kind: "dev" }),
    ],
  });
  const tasks = (await (await list()).json()) as { prompt: string }[];
  assert.deepEqual(
    tasks.map((t) => t.prompt),
    ["a task"]
  );
});

test("a feature's own history includes its queued dev runs", async () => {
  // Filtered by feature, dev runs must show up or board-queued work would be
  // invisible in the modal.
  const feature = await prisma.feature.create({
    data: { projectId, title: "F" },
  });
  await prisma.sandboxTask.createMany({
    data: [
      seedTask({ featureId: feature.id, prompt: "dev run", kind: "dev" }),
      seedTask({ featureId: feature.id, prompt: "task run" }),
    ],
  });
  const tasks = (await (await list(`?featureId=${feature.id}`)).json()) as {
    prompt: string;
  }[];
  assert.equal(tasks.length, 2);
});

test("newest tasks come first", async () => {
  const older = await prisma.sandboxTask.create({
    data: seedTask({ prompt: "older" }),
  });
  await prisma.sandboxTask.update({
    where: { id: older.id },
    data: { createdAt: new Date(Date.now() - 60_000) },
  });
  await prisma.sandboxTask.create({
    data: seedTask({ prompt: "newer" }),
  });
  const tasks = (await (await list()).json()) as { prompt: string }[];
  assert.deepEqual(
    tasks.map((t) => t.prompt),
    ["newer", "older"]
  );
});

test("task logs are not included in the history", async () => {
  // The list is a summary; logs are fetched per task and would bloat it.
  await prisma.sandboxTask.create({
    data: seedTask({ prompt: "p", log: "noisy output" }),
  });
  const tasks = (await (await list()).json()) as Record<string, unknown>[];
  assert.equal("log" in tasks[0], false);
});

test("a project with no tasks lists an empty array", async () => {
  assert.deepEqual(await (await list()).json(), []);
});

// --- recoverOrphanTasks -----------------------------------------------------
// runTask is an in-process promise, so a pipeline task left "running" at boot
// has no driver and never will. It used to stay running forever — DELETE
// refuses a running task, so the row could not even be cleared by hand. The
// dev console has swept its own orphans since D-15; this is the same sweep for
// the PR pipeline.

test("a running pipeline task is failed with an actionable reason", async () => {
  const task = await prisma.sandboxTask.create({
    data: { ...seedTask({ prompt: "ship it" }), status: "running", phase: "agent" },
  });
  await recoverOrphanTasks();
  const after = await prisma.sandboxTask.findUnique({ where: { id: task.id } });
  assert.equal(after?.status, "error");
  assert.match(after?.error ?? "", /server restart/i);
  assert.ok(after?.finishedAt, "finishedAt is stamped so the row reads as over");
});

test("a queued launch-and-run task is left for the supervisor", async () => {
  // recoverPendingLaunches re-attaches to these; failing them here would kill
  // a launch that is still perfectly recoverable.
  const task = await prisma.sandboxTask.create({
    data: { ...seedTask({ prompt: "provisioning" }), status: "queued", phase: "provision" },
  });
  await recoverOrphanTasks();
  const after = await prisma.sandboxTask.findUnique({ where: { id: task.id } });
  assert.equal(after?.status, "queued");
});

test("dev-console tasks are left to their own sweep", async () => {
  const task = await prisma.sandboxTask.create({
    data: { ...seedTask({ prompt: "chat", kind: "dev" }), status: "running" },
  });
  await recoverOrphanTasks();
  const after = await prisma.sandboxTask.findUnique({ where: { id: task.id } });
  assert.equal(after?.status, "running", "recoverDevQueues owns this one");
});

test("a finished task is not reopened", async () => {
  const done = await prisma.sandboxTask.create({
    data: { ...seedTask({ prompt: "done" }), status: "completed" },
  });
  await recoverOrphanTasks();
  const after = await prisma.sandboxTask.findUnique({ where: { id: done.id } });
  assert.equal(after?.status, "completed");
  assert.equal(after?.error, null);
});

test("every orphan is swept, not just the first", async () => {
  await Promise.all([
    prisma.sandboxTask.create({
      data: { ...seedTask({ prompt: "a" }), status: "running" },
    }),
    prisma.sandboxTask.create({
      data: { ...seedTask({ prompt: "b" }), status: "running" },
    }),
  ]);
  await recoverOrphanTasks();
  const left = await prisma.sandboxTask.count({
    where: { status: "running", kind: { not: "dev" } },
  });
  assert.equal(left, 0);
});

test("the sweep is a no-op when nothing is orphaned", async () => {
  await recoverOrphanTasks();
  assert.equal(await prisma.sandboxTask.count({ where: { status: "error" } }), 0);
});
