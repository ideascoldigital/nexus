import assert from "node:assert/strict";
import fs from "node:fs";
import { after, before, test } from "node:test";

// Env setup must stay above every other import — the route modules reach
// @nexux/db, whose client is built (and migrated) at module load.
import { testDbDir } from "./routes.test-setup";
import { NextRequest } from "next/server";
import { prisma } from "@nexux/db";

import {
  GET as listFeatures,
  POST as createFeature,
} from "./projects/[projectId]/features/route";
import {
  DELETE as deleteFeature,
  GET as getFeature,
  PUT as updateFeature,
} from "./projects/[projectId]/features/[featureId]/route";
import { POST as askAssistant } from "./projects/[projectId]/features/assistant/route";

let projectId: string;
let otherProjectId: string;

before(async () => {
  const workspace = await prisma.workspace.create({
    data: { id: "ws-routes-test", name: "Test" },
  });
  const [project, other] = await Promise.all([
    prisma.project.create({
      data: { name: "Main", workspaceId: workspace.id },
    }),
    prisma.project.create({
      data: { name: "Other", workspaceId: workspace.id },
    }),
  ]);
  projectId = project.id;
  otherProjectId = other.id;
});

after(async () => {
  await prisma.$disconnect();
  fs.rmSync(testDbDir, { recursive: true, force: true });
});

/** Each test gets a clean feature table so ordering stays predictable. */
async function reset() {
  await prisma.feature.deleteMany({});
  await prisma.devPhase.deleteMany({});
}

const post = (body: unknown, id = projectId) =>
  createFeature(
    new NextRequest("http://test/api/features", {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
    }),
    { params: Promise.resolve({ projectId: id }) }
  );

const put = (featureId: string, body: unknown, id = projectId) =>
  updateFeature(
    new NextRequest("http://test/api/features", {
      method: "PUT",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
    }),
    { params: Promise.resolve({ projectId: id, featureId }) }
  );

/** Create a feature through the route and return the parsed body. */
async function createOk(body: unknown, id = projectId) {
  const res = await post(body, id);
  assert.equal(res.status, 201, `expected 201, got ${res.status}`);
  return (await res.json()) as { id: string; order: number; status: string };
}

// --- POST /features ---------------------------------------------------------

test("a feature needs a title", async () => {
  await reset();
  const res = await post({ description: "no title" });
  assert.equal(res.status, 400);
  const body = (await res.json()) as { error: { fieldErrors: { title?: string[] } } };
  assert.ok(body.error.fieldErrors.title);
});

test("an empty title is rejected too", async () => {
  await reset();
  assert.equal((await post({ title: "" })).status, 400);
});

test("an unknown status or priority is rejected", async () => {
  await reset();
  assert.equal((await post({ title: "t", status: "shipped" })).status, 400);
  assert.equal((await post({ title: "t", priority: "critical" })).status, 400);
});

test("a valid feature is created with sensible defaults", async () => {
  await reset();
  const feature = await createOk({ title: "Add login" });
  assert.equal(feature.status, "backlog");
  const stored = await prisma.feature.findUnique({ where: { id: feature.id } });
  assert.equal(stored?.priority, "medium");
  assert.equal(stored?.projectId, projectId);
});

// --- createPr (the PR override) ---------------------------------------------
// NULL is "inherit the project policy" and has to survive the round trip as
// NULL — a schema that quietly coerced it to false would silently stop these
// features from following SandboxConfig.createPr.

test("a feature created without an opinion inherits (null)", async () => {
  await reset();
  const feature = await createOk({ title: "Add login" });
  const stored = await prisma.feature.findUnique({ where: { id: feature.id } });
  assert.equal(stored?.createPr, null);
});

test("an explicit null is stored as null, not coerced to false", async () => {
  await reset();
  const feature = await createOk({ title: "Add login", createPr: null });
  const stored = await prisma.feature.findUnique({ where: { id: feature.id } });
  assert.equal(stored?.createPr, null);
});

test("a feature can be pinned to always or never at creation", async () => {
  await reset();
  const always = await createOk({ title: "Ship it", createPr: true });
  const never = await createOk({ title: "Spike", createPr: false });
  const [a, n] = await Promise.all([
    prisma.feature.findUnique({ where: { id: always.id } }),
    prisma.feature.findUnique({ where: { id: never.id } }),
  ]);
  assert.equal(a?.createPr, true);
  assert.equal(n?.createPr, false);
});

test("an update can pin a feature and hand it back to the project default", async () => {
  await reset();
  const feature = await createOk({ title: "Add login" });
  const pinned = await put(feature.id, { createPr: false });
  assert.equal(pinned.status, 200);
  assert.equal(
    (await prisma.feature.findUnique({ where: { id: feature.id } }))?.createPr,
    false,
  );
  const released = await put(feature.id, { createPr: null });
  assert.equal(released.status, 200);
  assert.equal(
    (await prisma.feature.findUnique({ where: { id: feature.id } }))?.createPr,
    null,
  );
});

test("an update that omits createPr leaves the pin alone", async () => {
  await reset();
  const feature = await createOk({ title: "Add login", createPr: true });
  await put(feature.id, { title: "Add login v2" });
  const stored = await prisma.feature.findUnique({ where: { id: feature.id } });
  assert.equal(stored?.createPr, true);
  assert.equal(stored?.title, "Add login v2");
});

test("a non-boolean createPr is rejected", async () => {
  await reset();
  assert.equal((await post({ title: "x", createPr: "yes" })).status, 400);
  assert.equal((await post({ title: "x", createPr: 1 })).status, 400);
});

test("a long pasted description survives creation intact", async () => {
  await reset();
  // The drawer's real payload: a full design plan in the description field,
  // which has no cap by design — only the assistant's chat input does.
  const description = "d".repeat(19_000);
  const feature = await createOk({ title: "Restructure page", description });
  const stored = await prisma.feature.findUnique({ where: { id: feature.id } });
  assert.equal(stored?.description?.length, 19_000);
});

test("creating against a project that does not exist is a 404", async () => {
  await reset();
  const res = await post({ title: "orphan" }, "no-such-project");
  assert.equal(res.status, 404);
});

test("validation runs before the project is looked up", async () => {
  // An invalid body against a missing project should report the body, since
  // that is the error the caller can actually fix.
  await reset();
  const res = await post({ title: "" }, "no-such-project");
  assert.equal(res.status, 400);
});

test("features are ordered after the last one sharing their status", async () => {
  await reset();
  const first = await createOk({ title: "A" });
  const second = await createOk({ title: "B" });
  assert.equal(first.order, 0);
  assert.equal(second.order, 1);
});

test("each status column is ordered independently", async () => {
  // Order is per-column on the board, so a new "todo" starts at 0 even when
  // the backlog already has entries.
  await reset();
  await createOk({ title: "A" });
  await createOk({ title: "B" });
  const todo = await createOk({ title: "C", status: "todo" });
  assert.equal(todo.order, 0);
});

test("a dev phase from another project is refused", async () => {
  // Without this check a feature could be filed under a phase the project
  // does not own.
  await reset();
  const phase = await prisma.devPhase.create({
    data: { projectId: otherProjectId, name: "Phase", order: 0 },
  });
  const res = await post({ title: "t", devPhaseId: phase.id });
  assert.equal(res.status, 400);
  const body = (await res.json()) as { error: string };
  assert.match(body.error, /Dev phase not found/);
});

test("a dev phase from this project is accepted", async () => {
  await reset();
  const phase = await prisma.devPhase.create({
    data: { projectId, name: "Phase", order: 0 },
  });
  const feature = await createOk({ title: "t", devPhaseId: phase.id });
  const stored = await prisma.feature.findUnique({ where: { id: feature.id } });
  assert.equal(stored?.devPhaseId, phase.id);
});

// --- GET /features ----------------------------------------------------------

test("listing returns only this project's features", async () => {
  await reset();
  await createOk({ title: "Mine" });
  await createOk({ title: "Theirs" }, otherProjectId);
  const res = await listFeatures(new NextRequest("http://test/api/features"), {
    params: Promise.resolve({ projectId }),
  });
  const features = (await res.json()) as { title: string }[];
  assert.equal(res.status, 200);
  assert.deepEqual(
    features.map((f) => f.title),
    ["Mine"]
  );
});

test("a project with no features lists an empty array", async () => {
  await reset();
  const res = await listFeatures(new NextRequest("http://test/api/features"), {
    params: Promise.resolve({ projectId }),
  });
  assert.deepEqual(await res.json(), []);
});

// --- GET /features/[featureId] ----------------------------------------------

test("a feature can be read back by id", async () => {
  await reset();
  const created = await createOk({ title: "Readable" });
  const res = await getFeature(new NextRequest("http://test/api/f"), {
    params: Promise.resolve({ projectId, featureId: created.id }),
  });
  assert.equal(res.status, 200);
  const feature = (await res.json()) as { title: string };
  assert.equal(feature.title, "Readable");
});

test("reading a feature that does not exist is a 404", async () => {
  await reset();
  const res = await getFeature(new NextRequest("http://test/api/f"), {
    params: Promise.resolve({ projectId, featureId: "nope" }),
  });
  assert.equal(res.status, 404);
});

// --- PUT /features/[featureId] ----------------------------------------------

test("a partial update leaves untouched fields alone", async () => {
  await reset();
  const created = await createOk({ title: "Before", description: "keep me" });
  const res = await put(created.id, { title: "After" });
  assert.equal(res.status, 200);
  const stored = await prisma.feature.findUnique({ where: { id: created.id } });
  assert.equal(stored?.title, "After");
  assert.equal(stored?.description, "keep me");
});

test("updating a feature that does not exist is a 404", async () => {
  await reset();
  assert.equal((await put("nope", { title: "x" })).status, 404);
});

test("an invalid update is rejected before anything is written", async () => {
  await reset();
  const created = await createOk({ title: "Before" });
  assert.equal((await put(created.id, { title: "" })).status, 400);
  assert.equal((await put(created.id, { status: "shipped" })).status, 400);
  const stored = await prisma.feature.findUnique({ where: { id: created.id } });
  assert.equal(stored?.title, "Before");
});

test("a description can be cleared but a title cannot", async () => {
  await reset();
  const created = await createOk({ title: "T", description: "text" });
  assert.equal((await put(created.id, { description: null })).status, 200);
  assert.equal((await put(created.id, { title: null })).status, 400);
});

test("an update cannot move a feature to another project's phase", async () => {
  await reset();
  const created = await createOk({ title: "T" });
  const phase = await prisma.devPhase.create({
    data: { projectId: otherProjectId, name: "P", order: 0 },
  });
  const res = await put(created.id, { devPhaseId: phase.id });
  assert.equal(res.status, 400);
});

test("moving a feature to done reports success", async () => {
  // The handler also fires sandbox teardown; that is fire-and-forget and
  // must not affect the response.
  await reset();
  const created = await createOk({ title: "T" });
  const res = await put(created.id, { status: "done" });
  assert.equal(res.status, 200);
  const stored = await prisma.feature.findUnique({ where: { id: created.id } });
  assert.equal(stored?.status, "done");
});

// --- DELETE /features/[featureId] -------------------------------------------

test("a feature can be deleted", async () => {
  await reset();
  const created = await createOk({ title: "Doomed" });
  const res = await deleteFeature(new NextRequest("http://test/api/f"), {
    params: Promise.resolve({ projectId, featureId: created.id }),
  });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { success: true });
  assert.equal(
    await prisma.feature.findUnique({ where: { id: created.id } }),
    null
  );
});

// --- POST /features/assistant (body validation only) ------------------------
// The 400 branch runs before the project lookup and before the model call, so
// these drive the real handler without a brain behind it. The old ceiling
// rejected an ordinary pasted design doc and said only "Invalid body", which
// is how a length cap turned into a bug report.

const ask = (body: unknown, id = projectId) =>
  askAssistant(
    new NextRequest("http://test/api/features/assistant", {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
    }),
    { params: Promise.resolve({ projectId: id }) },
  );

const errorOf = async (res: Response) => {
  const body = (await res.json()) as { error?: string };
  return body.error ?? "";
};

// A body that validates falls through to the project lookup, so aiming these
// at a project that does not exist proves "the schema accepted it" as a clean
// 404 — no model, no Ollama, nothing that could hang or vary by environment.
const MISSING_PROJECT = "no-such-project";

test("a pasted design plan is accepted, not rejected as invalid", async () => {
  // ~19k chars: the size of a real spec pasted into the drawer, which the
  // previous 8k cap refused.
  const res = await ask({ message: "p".repeat(19_000), history: [] }, MISSING_PROJECT);
  assert.equal(res.status, 404);
});

test("a message at the cap is allowed, one past it is not", async () => {
  const atCap = await ask({ message: "a".repeat(32_000) }, MISSING_PROJECT);
  assert.equal(atCap.status, 404);
  assert.equal((await ask({ message: "a".repeat(32_001) })).status, 400);
});

test("an over-long message says how long it was and what the limit is", async () => {
  const error = await errorOf(await ask({ message: "a".repeat(40_000) }));
  assert.match(error, /40,000/);
  assert.match(error, /32,000/);
  assert.doesNotMatch(error, /Invalid body/);
});

test("length is measured after trimming, like the schema does", async () => {
  const padded = ` ${"a".repeat(32_000)} `;
  assert.equal((await ask({ message: padded }, MISSING_PROJECT)).status, 404);
});

test("an empty message is rejected as empty, not as too long", async () => {
  const res = await ask({ message: "   " });
  assert.equal(res.status, 400);
  assert.match(await errorOf(res), /empty/i);
});

test("too many history entries names the conversation, not the message", async () => {
  const history = Array.from({ length: 31 }, () => ({
    role: "user" as const,
    content: "hi",
  }));
  const res = await ask({ message: "scope this", history });
  assert.equal(res.status, 400);
  assert.match(await errorOf(res), /31 messages/);
});

test("one over-long history entry is reported as such", async () => {
  const history = [{ role: "user" as const, content: "x".repeat(16_001) }];
  const res = await ask({ message: "scope this", history });
  assert.equal(res.status, 400);
  assert.match(await errorOf(res), /earlier message/i);
});

test("a body that is not an object still 400s without throwing", async () => {
  const res = await ask(null);
  assert.equal(res.status, 400);
  assert.equal(await errorOf(res), "Invalid body");
});

// --- prUrls (the PRs a feature shows on the board) ----------------------------
// The links live on the runs; the routes flatten them to `prUrls`: distinct,
// newest run first, null rows dropped.

test("feature routes expose distinct PR links from runs, newest first", async () => {
  await reset();
  const sandbox = await prisma.sandbox.create({
    data: {
      projectId,
      name: "sb-prs",
      region: "lon1",
      size: "g4s.kube.small",
      workDir: "/tmp/sb-prs",
    },
  });
  const feature = await prisma.feature.create({
    data: { projectId, title: "Radio cards" },
  });
  const other = await prisma.feature.create({
    data: { projectId, title: "Other" },
  });

  const mk = (featureId: string, prUrl: string | null, createdAt: Date) =>
    prisma.sandboxTask.create({
      data: {
        sandboxId: sandbox.id,
        featureId,
        kind: "task",
        prompt: "p",
        workDir: "/tmp/sb-prs",
        status: "completed",
        prUrl,
        createdAt,
      },
    });

  const ui = "https://git.example.com/acme/group/acme-ui/-/merge_requests/280";
  const api = "https://git.example.com/acme/group/acme-api/-/merge_requests/9";
  await mk(feature.id, ui, new Date("2026-08-17T10:00:00Z"));
  // A follow-up repeats its parent's PR — the board must not show it twice.
  await mk(feature.id, ui, new Date("2026-08-17T11:00:00Z"));
  await mk(feature.id, api, new Date("2026-08-18T10:00:00Z"));
  // A run that never delivered contributes nothing.
  await mk(feature.id, null, new Date("2026-08-18T11:00:00Z"));
  // Another feature's PR must not leak in.
  await mk(other.id, "https://github.com/acme/app/pull/1", new Date());

  const listRes = await listFeatures(new NextRequest("http://test/api/features"), {
    params: Promise.resolve({ projectId }),
  });
  assert.equal(listRes.status, 200);
  const listed = (await listRes.json()) as Array<{ id: string; prUrls: string[] }>;
  assert.deepEqual(
    listed.find((f) => f.id === feature.id)?.prUrls,
    [api, ui],
    "distinct, newest run first",
  );
  assert.deepEqual(listed.find((f) => f.id === other.id)?.prUrls, [
    "https://github.com/acme/app/pull/1",
  ]);

  const oneRes = await getFeature(new NextRequest("http://test/api/features"), {
    params: Promise.resolve({ projectId, featureId: feature.id }),
  });
  assert.equal(oneRes.status, 200);
  const one = (await oneRes.json()) as { prUrls: string[] };
  assert.deepEqual(one.prUrls, [api, ui], "detail route matches the list");
});

// --- /plan (feature planning) --------------------------------------------------

test("plan GET reports the latest plan and whether one is running", async () => {
  await reset();
  const feature = await createOk({ title: "Plan me" });
  const { GET: getPlan, PATCH: patchPlan } = await import(
    "./projects/[projectId]/features/[featureId]/plan/route"
  );
  const read = () =>
    getPlan(new NextRequest("http://test/plan"), {
      params: Promise.resolve({ projectId, featureId: feature.id }),
    });

  // Never planned: null plan, nothing running.
  let body = (await (await read()).json()) as {
    plan: { id: string; status: string } | null;
    running: boolean;
    sandboxName: string | null;
  };
  assert.equal(body.plan, null);
  assert.equal(body.running, false);
  assert.equal(body.sandboxName, null, "never planned — no sandbox to name");

  // A plan row + an in-flight plan task surface together.
  const plan = await prisma.plan.create({
    data: {
      projectId,
      featureId: feature.id,
      title: "Plan me",
      content: "## Summary\ndo it",
      status: "draft",
    },
  });
  const sandbox = await prisma.sandbox.create({
    data: {
      projectId,
      name: "sb-plan-route",
      status: "running",
      dedicated: true,
      region: "lon1",
      size: "g4s.kube.small",
      workDir: "/tmp/sb",
    },
  });
  await prisma.sandboxTask.create({
    data: {
      sandboxId: sandbox.id,
      featureId: feature.id,
      kind: "plan",
      prompt: "Plan: Plan me",
      workDir: "/tmp/sb",
      status: "running",
    },
  });
  body = (await (await read()).json()) as typeof body;
  assert.equal(body.plan?.id, plan.id);
  assert.equal(body.running, true);
  assert.equal(body.sandboxName, "sb-plan-route", "names the sandbox it ran on");

  // Review verdict round-trips; a bogus status is rejected.
  const patch = (payload: unknown) =>
    patchPlan(
      new NextRequest("http://test/plan", {
        method: "PATCH",
        body: JSON.stringify(payload),
        headers: { "content-type": "application/json" },
      }),
      { params: Promise.resolve({ projectId, featureId: feature.id }) },
    );
  assert.equal((await patch({ planId: plan.id, status: "approved" })).status, 200);
  assert.equal(
    (await prisma.plan.findUnique({ where: { id: plan.id } }))?.status,
    "approved",
  );
  assert.equal((await patch({ planId: plan.id, status: "shipped" })).status, 400);
  assert.equal(
    (await patch({ planId: "nope", status: "approved" })).status,
    404,
  );
});

test("the features list carries the latest plan's status", async () => {
  await reset();
  const feature = await createOk({ title: "Planned" });
  await prisma.plan.create({
    data: {
      projectId,
      featureId: feature.id,
      title: "Planned",
      content: "plan",
      status: "approved",
    },
  });
  const res = await listFeatures(new NextRequest("http://test/f"), {
    params: Promise.resolve({ projectId }),
  });
  const listed = (await res.json()) as Array<{
    id: string;
    planStatus: string | null;
  }>;
  assert.equal(listed.find((f) => f.id === feature.id)?.planStatus, "approved");
});
