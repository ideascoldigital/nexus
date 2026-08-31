import { prisma } from "@nexux/db";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { enqueuePlanRun } from "@/lib/plan-runner";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ projectId: string; featureId: string }> };

/** Latest plan for the feature, plus whether one is being generated now. */
export async function GET(_req: NextRequest, { params }: Params) {
  const { projectId, featureId } = await params;

  const feature = await prisma.feature.findFirst({
    where: { id: featureId, projectId },
    select: { id: true },
  });
  if (!feature) {
    return NextResponse.json({ error: "Feature not found" }, { status: 404 });
  }

  const [plan, planTask] = await Promise.all([
    prisma.plan.findFirst({
      where: { featureId },
      orderBy: { updatedAt: "desc" },
      select: {
        id: true,
        title: true,
        content: true,
        status: true,
        createdAt: true,
        updatedAt: true,
      },
    }),
    // Latest plan run, settled or not — it names the sandbox that ran it.
    prisma.sandboxTask.findFirst({
      where: { featureId, kind: "plan" },
      orderBy: { createdAt: "desc" },
      select: { status: true, sandbox: { select: { name: true } } },
    }),
  ]);

  return NextResponse.json({
    plan,
    running:
      planTask?.status === "queued" || planTask?.status === "running",
    sandboxName: planTask?.sandbox.name ?? null,
  });
}

const postSchema = z.object({
  /** Present = revise the existing plan instead of starting over. */
  followUp: z.string().trim().min(1).max(10_000).optional(),
});

/** Kick off a read-only plan-mode run on the dev sandbox. */
export async function POST(req: NextRequest, { params }: Params) {
  const { projectId, featureId } = await params;

  // No body at all is the plain "generate" case.
  const raw = await req.json().catch(() => ({}));
  const parsed = postSchema.safeParse(raw ?? {});
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }

  try {
    const task = await enqueuePlanRun(projectId, featureId, {
      followUp: parsed.data.followUp,
    });
    return NextResponse.json({ taskId: task.id }, { status: 202 });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Could not start the plan";
    const status = message === "Feature not found" ? 404 : 409;
    return NextResponse.json({ error: message }, { status });
  }
}

const patchSchema = z.object({
  planId: z.string().min(1),
  status: z.enum(["draft", "pending_review", "approved", "rejected"]),
});

/** Review verdict on a plan (approve / reject / back to draft). */
export async function PATCH(req: NextRequest, { params }: Params) {
  const { projectId, featureId } = await params;

  const parsed = patchSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }

  const updated = await prisma.plan.updateMany({
    where: { id: parsed.data.planId, featureId, projectId },
    data: { status: parsed.data.status },
  });
  if (updated.count === 0) {
    return NextResponse.json({ error: "Plan not found" }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}
