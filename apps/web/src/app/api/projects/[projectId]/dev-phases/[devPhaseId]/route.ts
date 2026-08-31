import { prisma } from "@nexux/db";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

type Params = { params: Promise<{ projectId: string; devPhaseId: string }> };

const updateDevPhaseSchema = z.object({
  name: z.string().min(1).optional(),
  goal: z.string().nullable().optional(),
  status: z.enum(["planned", "in_progress", "done"]).optional(),
  order: z.number().int().nonnegative().optional(),
});

export async function PUT(req: NextRequest, { params }: Params) {
  const { projectId, devPhaseId } = await params;

  const body = await req.json();
  const parsed = updateDevPhaseSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const existing = await prisma.devPhase.findFirst({
    where: { id: devPhaseId, projectId },
  });
  if (!existing) {
    return NextResponse.json({ error: "Dev phase not found" }, { status: 404 });
  }

  const phase = await prisma.devPhase.update({
    where: { id: devPhaseId },
    data: {
      ...parsed.data,
      goal:
        parsed.data.goal === undefined
          ? undefined
          : parsed.data.goal?.trim() || null,
    },
    include: { _count: { select: { features: true } } },
  });

  return NextResponse.json(phase);
}

export async function DELETE(_req: NextRequest, { params }: Params) {
  const { projectId, devPhaseId } = await params;

  const existing = await prisma.devPhase.findFirst({
    where: { id: devPhaseId, projectId },
  });
  if (!existing) {
    return NextResponse.json({ error: "Dev phase not found" }, { status: 404 });
  }

  // Features survive: devPhaseId is SetNull on delete.
  await prisma.devPhase.delete({ where: { id: devPhaseId } });
  return NextResponse.json({ success: true });
}
