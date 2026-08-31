import { prisma } from "@nexux/db";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

type Params = { params: Promise<{ projectId: string }> };

// Replace-set semantics: the payload is the project's whole skill list, so a
// malformed body must be refused before the existing rows are deleted.
const putSchema = z.object({
  skillIds: z.array(z.string().min(1)),
});

export async function GET(_req: NextRequest, { params }: Params) {
  const { projectId } = await params;

  const projectSkills = await prisma.projectSkill.findMany({
    where: { projectId },
    include: { skill: true },
  });

  return NextResponse.json(projectSkills.map((ps) => ps.skill));
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
  const { skillIds } = parsed.data;

  // Entries arrive as ids — and sometimes as names: the recommender has
  // emitted slugs where ids belong, and createMany's FK violation used to
  // land AFTER the wipe, leaving the project skill-less with a 500. Resolve
  // both spellings first, refuse what matches neither, and only then touch
  // the existing rows — atomically.
  const skills = await prisma.skill.findMany({
    where: { OR: [{ id: { in: skillIds } }, { name: { in: skillIds } }] },
    select: { id: true, name: true },
  });
  const byId = new Set(skills.map((s) => s.id));
  const idByName = new Map(skills.map((s) => [s.name, s.id]));
  const unknown = skillIds.filter((e) => !byId.has(e) && !idByName.has(e));
  if (unknown.length > 0) {
    return NextResponse.json(
      {
        error: `Unknown skill${unknown.length > 1 ? "s" : ""}: ${unknown.join(", ")}`,
      },
      { status: 400 },
    );
  }
  // Dedupe: an id and its own name in one payload is one attachment.
  const resolved = [
    ...new Set(skillIds.map((e) => (byId.has(e) ? e : idByName.get(e)!))),
  ];

  await prisma.$transaction([
    prisma.projectSkill.deleteMany({ where: { projectId } }),
    ...(resolved.length > 0
      ? [
          prisma.projectSkill.createMany({
            data: resolved.map((skillId) => ({ projectId, skillId })),
          }),
        ]
      : []),
  ]);

  const updated = await prisma.projectSkill.findMany({
    where: { projectId },
    include: { skill: true },
  });

  return NextResponse.json(updated.map((ps) => ps.skill));
}
