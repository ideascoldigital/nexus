import assert from "node:assert/strict";
import fs from "node:fs";
import { after, before, beforeEach, test } from "node:test";

// Env setup must stay above every other import — the route modules reach
// @nexux/db, whose client is built (and migrated) at module load.
import { testDbDir } from "./routes.test-setup";
import { NextRequest } from "next/server";
import { prisma } from "@nexux/db";

import { PUT as putAgents } from "./projects/[projectId]/agents/route";
import { PUT as putSkills } from "./projects/[projectId]/skills/route";
import { PUT as putOrchestration } from "./projects/[projectId]/orchestration/route";
import { PUT as putBrain } from "./projects/[projectId]/brain/route";
import { PUT as putConversation } from "./projects/[projectId]/conversations/[conversationId]/route";

let projectId: string;
let agentId: string;
let skillId: string;
let conversationId: string;

before(async () => {
  const workspace = await prisma.workspace.create({
    data: { id: "ws-validation-test", name: "Validation" },
  });
  const project = await prisma.project.create({
    data: { name: "Main", workspaceId: workspace.id },
  });
  projectId = project.id;
  const [agent, skill] = await Promise.all([
    prisma.agent.create({
      data: {
        name: "reviewer",
        workspaceId: workspace.id,
        systemPrompt: "review the diff",
      },
    }),
    prisma.skill.create({
      data: { name: "deploy", workspaceId: workspace.id },
    }),
  ]);
  agentId = agent.id;
  skillId = skill.id;
});

after(async () => {
  await prisma.$disconnect();
  fs.rmSync(testDbDir, { recursive: true, force: true });
});

beforeEach(async () => {
  await prisma.agentSkill.deleteMany({});
  await prisma.projectAgent.deleteMany({});
  await prisma.projectSkill.deleteMany({});
  await prisma.projectBrain.deleteMany({});
  await prisma.conversation.deleteMany({});
  const conversation = await prisma.conversation.create({
    data: { projectId, sessionId: `s-${Date.now()}`, name: "Chat" },
  });
  conversationId = conversation.id;
});

const req = (body: unknown) =>
  new NextRequest("http://test/api/r", {
    method: "PUT",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });

/**
 * A fresh context per call: `projectId` is only assigned in before(), and a
 * params promise must not be shared across handlers that each await it.
 */
const ctx = () => ({ params: Promise.resolve({ projectId }) });

/** Bodies that used to crash the handler with a 500. */
const BAD_BODIES: [string, unknown][] = [
  ["an empty object", {}],
  ["null", null],
  ["a string", "nope"],
  ["a number", 7],
];

// --- agents -----------------------------------------------------------------

for (const [label, body] of BAD_BODIES) {
  test(`agents PUT rejects ${label}`, async () => {
    const res = await putAgents(req(body), ctx());
    assert.equal(res.status, 400);
  });
}

test("agents PUT rejects a non-array agentIds", async () => {
  const res = await putAgents(req({ agentIds: "oops" }), {
    params: Promise.resolve({ projectId }),
  });
  assert.equal(res.status, 400);
});

test("agents PUT rejects a non-string id inside the array", async () => {
  const res = await putAgents(req({ agentIds: [1, 2] }), {
    params: Promise.resolve({ projectId }),
  });
  assert.equal(res.status, 400);
});

test("a refused agents PUT deletes nothing", async () => {
  // The handler deletes before it re-creates, so a body it cannot read must
  // be refused before any row is touched.
  await prisma.projectAgent.create({ data: { projectId, agentId } });
  const res = await putAgents(req({}), ctx());
  assert.equal(res.status, 400);
  assert.equal(await prisma.projectAgent.count({ where: { projectId } }), 1);
});

test("a valid agents PUT still replaces the set", async () => {
  const res = await putAgents(req({ agentIds: [agentId] }), {
    params: Promise.resolve({ projectId }),
  });
  assert.equal(res.status, 200);
  assert.equal(await prisma.projectAgent.count({ where: { projectId } }), 1);

  const cleared = await putAgents(req({ agentIds: [] }), {
    params: Promise.resolve({ projectId }),
  });
  assert.equal(cleared.status, 200);
  assert.equal(await prisma.projectAgent.count({ where: { projectId } }), 0);
});

// --- skills -----------------------------------------------------------------

for (const [label, body] of BAD_BODIES) {
  test(`skills PUT rejects ${label}`, async () => {
    const res = await putSkills(req(body), ctx());
    assert.equal(res.status, 400);
  });
}

test("a refused skills PUT deletes nothing", async () => {
  await prisma.projectSkill.create({ data: { projectId, skillId } });
  const res = await putSkills(req({ skillIds: "oops" }), {
    params: Promise.resolve({ projectId }),
  });
  assert.equal(res.status, 400);
  assert.equal(await prisma.projectSkill.count({ where: { projectId } }), 1);
});

test("a valid skills PUT still replaces the set", async () => {
  const res = await putSkills(req({ skillIds: [skillId] }), {
    params: Promise.resolve({ projectId }),
  });
  assert.equal(res.status, 200);
  assert.equal(await prisma.projectSkill.count({ where: { projectId } }), 1);
});

// --- orchestration ----------------------------------------------------------

for (const [label, body] of BAD_BODIES) {
  test(`orchestration PUT rejects ${label}`, async () => {
    const res = await putOrchestration(req(body), {
      params: Promise.resolve({ projectId }),
    });
    assert.equal(res.status, 400);
  });
}

test("orchestration PUT rejects an edge missing its ids", async () => {
  const res = await putOrchestration(req({ edges: [{ agentId }] }), {
    params: Promise.resolve({ projectId }),
  });
  assert.equal(res.status, 400);
});

test("a refused orchestration PUT deletes nothing", async () => {
  await prisma.agentSkill.create({ data: { projectId, agentId, skillId } });
  const res = await putOrchestration(req({}), {
    params: Promise.resolve({ projectId }),
  });
  assert.equal(res.status, 400);
  assert.equal(await prisma.agentSkill.count({ where: { projectId } }), 1);
});

test("a valid orchestration PUT still replaces the wiring", async () => {
  const res = await putOrchestration(req({ edges: [{ agentId, skillId }] }), {
    params: Promise.resolve({ projectId }),
  });
  assert.equal(res.status, 200);
  assert.equal(await prisma.agentSkill.count({ where: { projectId } }), 1);
});

// --- brain ------------------------------------------------------------------

for (const [label, body] of BAD_BODIES) {
  test(`brain PUT rejects ${label}`, async () => {
    const res = await putBrain(req(body) as unknown as Request, ctx());
    assert.equal(res.status, 400);
  });
}

test("brain PUT requires both a provider and a model", async () => {
  assert.equal(
    (await putBrain(req({ provider: "claude" }) as unknown as Request, ctx()))
      .status,
    400
  );
  assert.equal(
    (await putBrain(req({ model: "opus" }) as unknown as Request, ctx())).status,
    400
  );
});

test("brain PUT ignores columns ProjectBrain does not have", async () => {
  // The body used to reach prisma.upsert unfiltered.
  const res = await putBrain(
    req({ provider: "claude", model: "opus", projectId: "someone-elses" }) as unknown as Request,
    ctx()
  );
  assert.equal(res.status, 200);
  const brain = await prisma.projectBrain.findUnique({ where: { projectId } });
  assert.equal(brain?.projectId, projectId);
  assert.equal(brain?.provider, "claude");
});

test("brain PUT stores an optional config object", async () => {
  const res = await putBrain(
    req({ provider: "ollama", model: "llama3", config: { temperature: 0.2 } }) as unknown as Request,
    ctx()
  );
  assert.equal(res.status, 200);
  const brain = await prisma.projectBrain.findUnique({ where: { projectId } });
  assert.deepEqual(brain?.config, { temperature: 0.2 });
});

// --- conversations ----------------------------------------------------------

test("conversation PUT rejects a body that is not an object", async () => {
  for (const body of ["nope", 7, null]) {
    const res = await putConversation(req(body), {
      params: Promise.resolve({ projectId, conversationId }),
    });
    assert.equal(res.status, 400, `body ${JSON.stringify(body)}`);
  }
});

test("conversation PUT rejects an unparseable lastActivity", async () => {
  // This used to become `new Date("not a date")` — an Invalid Date written
  // straight to the column.
  const res = await putConversation(req({ lastActivity: "not a date" }), {
    params: Promise.resolve({ projectId, conversationId }),
  });
  assert.equal(res.status, 400);
});

test("conversation PUT rejects an unknown status", async () => {
  const res = await putConversation(req({ status: "exploded" }), {
    params: Promise.resolve({ projectId, conversationId }),
  });
  assert.equal(res.status, 400);
});

test("conversation PUT rejects a negative cost", async () => {
  const res = await putConversation(req({ totalCostUsd: -5 }), {
    params: Promise.resolve({ projectId, conversationId }),
  });
  assert.equal(res.status, 400);
});

test("updating a conversation that does not exist is a 404", async () => {
  const res = await putConversation(req({ name: "x" }), {
    params: Promise.resolve({ projectId, conversationId: "nope" }),
  });
  assert.equal(res.status, 404);
});

test("an empty conversation update is a no-op, not an error", async () => {
  const res = await putConversation(req({}), {
    params: Promise.resolve({ projectId, conversationId }),
  });
  assert.equal(res.status, 200);
});

test("a valid conversation update still writes each field", async () => {
  const when = new Date("2026-07-31T12:00:00.000Z");
  const res = await putConversation(
    req({
      name: "Renamed",
      status: "running",
      totalCostUsd: 1.5,
      lastActivity: when.toISOString(),
    }),
    { params: Promise.resolve({ projectId, conversationId }) }
  );
  assert.equal(res.status, 200);
  const stored = await prisma.conversation.findUnique({
    where: { id: conversationId },
  });
  assert.equal(stored?.name, "Renamed");
  assert.equal(stored?.status, "running");
  assert.equal(stored?.totalCostUsd, 1.5);
  assert.equal(stored?.lastActivity.toISOString(), when.toISOString());
});

test("a conversation name can be cleared", async () => {
  const res = await putConversation(req({ name: null }), {
    params: Promise.resolve({ projectId, conversationId }),
  });
  assert.equal(res.status, 200);
  const stored = await prisma.conversation.findUnique({
    where: { id: conversationId },
  });
  assert.equal(stored?.name, null);
});
