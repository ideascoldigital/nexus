import { prisma } from "@nexux/db";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

const createDevPhaseSchema = z.object({
  name: z.string().min(1, "Name is required"),
  goal: z.string().optional(),
  status: z.enum(["planned", "in_progress", "done"]).default("planned"),
});

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ projectId: string }> }
) {
  const { projectId } = await params;

  const phases = await prisma.devPhase.findMany({
    where: { projectId },
    orderBy: { order: "asc" },
    include: { _count: { select: { features: true } } },
  });

  return NextResponse.json(phases);
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ projectId: string }> }
) {
  const { projectId } = await params;

  const body = await req.json();
  const parsed = createDevPhaseSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const project = await prisma.project.findUnique({ where: { id: projectId } });
  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  const last = await prisma.devPhase.findFirst({
    where: { projectId },
    orderBy: { order: "desc" },
    select: { order: true },
  });

  const phase = await prisma.devPhase.create({
    data: {
      ...parsed.data,
      goal: parsed.data.goal?.trim() || null,
      projectId,
      order: (last?.order ?? -1) + 1,
    },
    include: { _count: { select: { features: true } } },
  });

  return NextResponse.json(phase, { status: 201 });
}
