import { prisma } from "@nexux/db";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

type Params = { params: Promise<{ projectId: string; featureId: string }> };

const updateFeatureSchema = z.object({
  title: z.string().min(1, "Title is required").optional(),
  description: z.string().nullable().optional(),
  status: z
    .enum(["backlog", "todo", "queued", "in_progress", "in_review", "done"])
    .optional(),
  priority: z.enum(["low", "medium", "high", "urgent"]).optional(),
  // null = inherit the project's sandbox policy; true/false pin this feature.
  createPr: z.boolean().nullable().optional(),
  order: z.number().int().optional(),
  aiRefinement: z.string().nullable().optional(),
  devPhaseId: z.string().nullable().optional(),
});

export async function GET(_req: NextRequest, { params }: Params) {
  const { featureId } = await params;

  const feature = await prisma.feature.findUnique({
    where: { id: featureId },
    include: {
      _count: { select: { conversations: true, plans: true } },
      // Same shape the list route exposes — the PR chips read prUrls.
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

  if (!feature) {
    return NextResponse.json({ error: "Feature not found" }, { status: 404 });
  }

  const { sandboxTasks, plans, ...rest } = feature;
  return NextResponse.json({
    ...rest,
    prUrls: [...new Set(sandboxTasks.map((t) => t.prUrl!))],
    planStatus: plans[0]?.status ?? null,
  });
}

export async function PUT(req: NextRequest, { params }: Params) {
  const { projectId, featureId } = await params;

  const body = await req.json();
  const parsed = updateFeatureSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const existing = await prisma.feature.findUnique({
    where: { id: featureId },
  });
  if (!existing) {
    return NextResponse.json({ error: "Feature not found" }, { status: 404 });
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

  const feature = await prisma.feature.update({
    where: { id: featureId },
    data: parsed.data,
  });

  // Board queue: entering the Queue column dispatches (in order) to the
  // project's dev sandbox; without one the feature waits on the board.
  if (parsed.data.status === "queued" && existing.status !== "queued") {
    const { flushFeatureQueue } = await import("@/lib/dev-console");
    void flushFeatureQueue(projectId).catch(() => undefined);
  }

  // Done features release their work sandboxes (never dev sandboxes) — the
  // instance billed/idled for review is no longer needed once the feature
  // lands. Fire-and-forget; destruction shows up in the sandbox list.
  if (parsed.data.status === "done" && existing.status !== "done") {
    const { destroyFeatureSandboxes } = await import("@/lib/task-manager");
    void destroyFeatureSandboxes(featureId).catch(() => undefined);
  }

  return NextResponse.json(feature);
}

export async function DELETE(_req: NextRequest, { params }: Params) {
  const { featureId } = await params;

  await prisma.feature.delete({ where: { id: featureId } });
  return NextResponse.json({ success: true });
}
