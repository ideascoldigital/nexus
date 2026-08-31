import { prisma } from "@nexux/db";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  buildFeaturePrompt,
  createTask,
  launchAndRunTask,
} from "@/lib/task-manager";
import { latestPlanContent } from "@/lib/plan-runner";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ projectId: string }> };

// GET /api/projects/:id/tasks[?featureId=...] — task history (no logs)
export async function GET(req: NextRequest, { params }: Params) {
  const { projectId } = await params;
  const featureId = new URL(req.url).searchParams.get("featureId");

  const tasks = await prisma.sandboxTask.findMany({
    where: {
      sandbox: { projectId },
      // The global task list hides dev-console prompts (they live in the
      // chat feed) — but a feature's own history includes its queued dev
      // runs, or board-queued work would be invisible in the modal.
      ...(featureId ? { featureId } : { kind: "task" }),
    },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      sandboxId: true,
      featureId: true,
      prompt: true,
      workDir: true,
      status: true,
      phase: true,
      branch: true,
      prUrl: true,
      previewUrl: true,
      result: true,
      costUsd: true,
      durationMs: true,
      error: true,
      createdAt: true,
      updatedAt: true,
      finishedAt: true,
      sandbox: { select: { name: true, publicIp: true } },
      feature: { select: { title: true } },
    },
  });

  return NextResponse.json(tasks);
}

const createSchema = z
  .object({
    sandboxId: z.string().min(1).optional(),
    /** M1 — Launch & Run: provision a sandbox and dispatch when it's ready. */
    launch: z.boolean().optional(),
    featureId: z.string().optional(),
    prompt: z.string().optional(),
    followUpOf: z.string().optional(),
  })
  .refine((d) => d.sandboxId || d.launch, {
    message: "Either sandboxId or launch is required",
  })
  .refine((d) => d.featureId || d.prompt?.trim() || d.followUpOf, {
    message: "Either featureId, prompt or followUpOf is required",
  })
  .refine((d) => !d.followUpOf || d.prompt?.trim(), {
    message: "A follow-up needs a prompt",
  })
  .refine((d) => !d.launch || !d.followUpOf, {
    message: "Follow-ups run on the sandbox that owns the session",
  });

// POST /api/projects/:id/tasks — send work to a running sandbox
export async function POST(req: NextRequest, { params }: Params) {
  const { projectId } = await params;
  const parsed = createSchema.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const { sandboxId, featureId, followUpOf } = parsed.data;
  let prompt = parsed.data.prompt?.trim() ?? "";

  if (featureId) {
    const feature = await prisma.feature.findFirst({
      where: { id: featureId, projectId },
      include: { devPhase: { select: { name: true, goal: true } } },
    });
    if (!feature) {
      return NextResponse.json(
        { error: "Feature not found in this project" },
        { status: 400 },
      );
    }
    // An explicit prompt overrides the feature-derived one.
    if (!prompt) {
      prompt = buildFeaturePrompt({
        ...feature,
        planContent: await latestPlanContent(feature.id),
      });
    }
  }

  try {
    if (!sandboxId) {
      const { sandboxId: launched } = await launchAndRunTask({
        projectId,
        featureId: featureId ?? null,
        prompt,
      });
      return NextResponse.json(
        { launched: true, sandboxId: launched },
        { status: 202 },
      );
    }
    const task = await createTask({
      projectId,
      sandboxId,
      featureId: featureId ?? null,
      prompt,
      followUpOf: followUpOf ?? null,
    });
    return NextResponse.json(task, { status: 202 });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to start task";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
