import { prisma } from "@nexux/db";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

type Params = { params: Promise<{ projectId: string }> };

// Replace-set semantics: the payload is the project's whole agent list, so a
// malformed body must be refused before the existing rows are deleted.
const putSchema = z.object({
  agentIds: z.array(z.string().min(1)),
});

export async function GET(_req: NextRequest, { params }: Params) {
  const { projectId } = await params;

  const projectAgents = await prisma.projectAgent.findMany({
    where: { projectId },
    include: { agent: true },
  });

  return NextResponse.json(projectAgents.map((pa) => pa.agent));
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
  const { agentIds } = parsed.data;

  // Same hardening as the skills twin: entries may be ids or names, an
  // unknown entry is a 400 (never a post-wipe 500), and the replace-set is
  // atomic so a failure cannot leave the project half-updated.
  const agents = await prisma.agent.findMany({
    where: { OR: [{ id: { in: agentIds } }, { name: { in: agentIds } }] },
    select: { id: true, name: true },
  });
  const byId = new Set(agents.map((a) => a.id));
  const idByName = new Map(agents.map((a) => [a.name, a.id]));
  const unknown = agentIds.filter((e) => !byId.has(e) && !idByName.has(e));
  if (unknown.length > 0) {
    return NextResponse.json(
      {
        error: `Unknown agent${unknown.length > 1 ? "s" : ""}: ${unknown.join(", ")}`,
      },
      { status: 400 },
    );
  }
  const resolved = [
    ...new Set(agentIds.map((e) => (byId.has(e) ? e : idByName.get(e)!))),
  ];

  await prisma.$transaction([
    prisma.projectAgent.deleteMany({ where: { projectId } }),
    ...(resolved.length > 0
      ? [
          prisma.projectAgent.createMany({
            data: resolved.map((agentId) => ({ projectId, agentId })),
          }),
        ]
      : []),
  ]);

  const updated = await prisma.projectAgent.findMany({
    where: { projectId },
    include: { agent: true },
  });

  return NextResponse.json(updated.map((pa) => pa.agent));
}
