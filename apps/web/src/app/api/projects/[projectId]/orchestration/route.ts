import { prisma } from "@nexux/db";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

type Params = { params: Promise<{ projectId: string }> };

// Replace-set semantics: the payload is every agent↔skill edge in the
// project, so a malformed body must be refused before the wiring is deleted.
const putSchema = z.object({
  edges: z.array(
    z.object({
      agentId: z.string().min(1),
      skillId: z.string().min(1),
    })
  ),
});

export async function GET(_req: NextRequest, { params }: Params) {
  const { projectId } = await params;

  const [projectAgents, projectSkills] = await Promise.all([
    prisma.projectAgent.findMany({
      where: { projectId },
      include: { agent: true },
    }),
    prisma.projectSkill.findMany({
      where: { projectId },
      include: { skill: true },
    }),
  ]);

  const agentIds = projectAgents.map((pa) => pa.agentId);
  const skillIds = projectSkills.map((ps) => ps.skillId);

  const edges = await prisma.agentSkill.findMany({
    where: {
      agentId: { in: agentIds },
      skillId: { in: skillIds },
      OR: [{ projectId }, { projectId: null }],
    },
  });

  return NextResponse.json({
    agents: projectAgents.map((pa) => pa.agent),
    skills: projectSkills.map((ps) => ps.skill),
    edges: edges.map((e) => ({
      id: e.id,
      agentId: e.agentId,
      skillId: e.skillId,
      scope: e.projectId ? "project" : "global",
    })),
  });
}

export async function PUT(req: NextRequest, { params }: Params) {
  const { projectId } = await params;
  const parsed = putSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.flatten() },
      { status: 400 }
    );
  }
  const { edges } = parsed.data;

  await prisma.agentSkill.deleteMany({ where: { projectId } });

  if (edges.length > 0) {
    await prisma.agentSkill.createMany({
      data: edges.map((e) => ({
        agentId: e.agentId,
        skillId: e.skillId,
        projectId,
      })),
    });
  }

  return NextResponse.json({ ok: true, count: edges.length });
}
