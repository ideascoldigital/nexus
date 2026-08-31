import { prisma } from "@nexux/db";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

const createFeatureSchema = z.object({
  title: z.string().min(1, "Title is required"),
  description: z.string().optional(),
  status: z
    .enum(["backlog", "todo", "queued", "in_progress", "in_review", "done"])
    .default("backlog"),
  priority: z.enum(["low", "medium", "high", "urgent"]).default("medium"),
  // null = inherit the project's sandbox policy; true/false pin this feature.
  createPr: z.boolean().nullable().optional(),
  devPhaseId: z.string().nullable().optional(),
});

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ projectId: string }> }
) {
  const { projectId } = await params;

  const features = await prisma.feature.findMany({
    where: { projectId },
    orderBy: [{ status: "asc" }, { order: "asc" }, { createdAt: "desc" }],
    include: {
      devPhase: { select: { id: true, name: true, status: true } },
      _count: { select: { conversations: true, plans: true, featureIssues: true } },
      // PR/MR links live on the runs — surfaced so the board can show them.
      sandboxTasks: {
        where: { prUrl: { not: null } },
        orderBy: { createdAt: "desc" },
        select: { prUrl: true },
      },
      plans: {
        orderBy: { updatedAt: "desc" },
        take: 1,
        select: { status: true },
      },
    },
  });

  return NextResponse.json(
    features.map(({ sandboxTasks, plans, ...f }) => ({
      ...f,
      prUrls: [...new Set(sandboxTasks.map((t) => t.prUrl!))],
      planStatus: plans[0]?.status ?? null,
    })),
  );
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ projectId: string }> }
) {
  const { projectId } = await params;

  const body = await req.json();
  const parsed = createFeatureSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const project = await prisma.project.findUnique({
    where: { id: projectId },
  });
  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  if (parsed.data.devPhaseId) {
    const phase = await prisma.devPhase.findFirst({
      where: { id: parsed.data.devPhaseId, projectId },
      select: { id: true },
    });
    if (!phase) {
      return NextResponse.json(
        { error: "Dev phase not found in this project" },
        { status: 400 }
      );
    }
  }

  // Set order to be after the last feature with the same status
  const lastFeature = await prisma.feature.findFirst({
    where: { projectId, status: parsed.data.status },
    orderBy: { order: "desc" },
    select: { order: true },
  });

  const feature = await prisma.feature.create({
    data: {
      ...parsed.data,
      projectId,
      order: (lastFeature?.order ?? -1) + 1,
    },
  });

  return NextResponse.json(feature, { status: 201 });
}
