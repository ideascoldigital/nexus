import assert from "node:assert/strict";
import { test } from "node:test";
import { NextRequest } from "next/server";

// Env setup must stay above the route imports — @nexux/db builds its client
// at module load against the throwaway SQLite file this configures.
import "./routes.test-setup";

import { prisma } from "@nexux/db";
import { PUT as putSkills } from "./projects/[projectId]/skills/route";
import { PUT as putAgents } from "./projects/[projectId]/agents/route";

// Replace-set hardening, born from a real 500: the recommender sent a skill
// NAME where an id belongs, createMany hit the FK after the wipe, and the
// project ended up skill-less. Names now resolve, unknowns 400 BEFORE any
// delete, and the swap is atomic.

type PutHandler = (
  req: NextRequest,
  ctx: { params: Promise<{ projectId: string }> },
) => Promise<Response>;

const put = (handler: PutHandler, projectId: string, body: unknown) =>
  handler(
    new NextRequest("http://test/x", {
      method: "PUT",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
    }),
    { params: Promise.resolve({ projectId }) },
  );

test("project skills PUT resolves names, refuses unknowns without wiping", async () => {
  const project = await prisma.project.create({ data: { name: "ps" } });
  const [a, b] = await Promise.all([
    prisma.skill.create({ data: { name: "frontend-coding-standards" } }),
    prisma.skill.create({ data: { name: "dataviz" } }),
  ]);

  // Mixed ids and names — including the same skill spelled both ways.
  let res = await put(putSkills, project.id, {
    skillIds: [a.id, "dataviz", "frontend-coding-standards"],
  });
  assert.equal(res.status, 200);
  const attached = (await res.json()) as Array<{ id: string }>;
  assert.deepEqual(
    attached.map((s) => s.id).sort(),
    [a.id, b.id].sort(),
    "name resolved, duplicate spelling collapsed",
  );

  // An unknown entry refuses BEFORE touching rows — the old code wiped first.
  res = await put(putSkills, project.id, {
    skillIds: [a.id, "no-such-skill"],
  });
  assert.equal(res.status, 400);
  assert.match(((await res.json()) as { error: string }).error, /no-such-skill/);
  assert.equal(
    await prisma.projectSkill.count({ where: { projectId: project.id } }),
    2,
    "existing attachments survive a rejected payload",
  );

  // Empty list clears the set — replace semantics stay intact.
  res = await put(putSkills, project.id, { skillIds: [] });
  assert.equal(res.status, 200);
  assert.equal(
    await prisma.projectSkill.count({ where: { projectId: project.id } }),
    0,
  );
});

test("project agents PUT gets the same treatment", async () => {
  const project = await prisma.project.create({ data: { name: "pa" } });
  const agent = await prisma.agent.create({
    data: { name: "db-migrator", systemPrompt: "p" },
  });
  await prisma.projectAgent.create({
    data: { projectId: project.id, agentId: agent.id },
  });

  const res = await put(putAgents, project.id, {
    agentIds: ["db-migrator", "ghost-agent"],
  });
  assert.equal(res.status, 400);
  assert.equal(
    await prisma.projectAgent.count({ where: { projectId: project.id } }),
    1,
    "the wipe never happened",
  );

  const ok = await put(putAgents, project.id, { agentIds: ["db-migrator"] });
  assert.equal(ok.status, 200);
});
