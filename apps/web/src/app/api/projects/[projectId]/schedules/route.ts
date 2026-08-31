import { prisma } from "@nexux/db";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { computeNextRunAt, isValidCron } from "@/lib/task-scheduler";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ projectId: string }> };

export async function GET(_req: NextRequest, { params }: Params) {
  const { projectId } = await params;
  const schedules = await prisma.taskSchedule.findMany({
    where: { projectId },
    orderBy: { createdAt: "desc" },
    include: { feature: { select: { title: true } } },
  });
  return NextResponse.json(schedules);
}

const createSchema = z
  .object({
    featureId: z.string().optional(),
    prompt: z.string().optional(),
    provider: z.enum(["civo", "aws", "local"]).default("local"),
    ephemeral: z.boolean().default(true),
    cron: z.string().optional(),
    runAt: z.string().datetime().optional(),
  })
  .refine((d) => d.featureId || d.prompt?.trim(), {
    message: "Either featureId or prompt is required",
  })
  .refine((d) => Boolean(d.cron) !== Boolean(d.runAt), {
    message: "Exactly one of cron (recurring) or runAt (one-shot) is required",
  })
  .refine((d) => !d.cron || isValidCron(d.cron), {
    message: "Invalid cron expression (5 fields, e.g. '0 9 * * 1-5')",
  });

export async function POST(req: NextRequest, { params }: Params) {
  const { projectId } = await params;
  const parsed = createSchema.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  const { featureId, prompt, provider, ephemeral, cron, runAt } = parsed.data;

  if (featureId) {
    const feature = await prisma.feature.findFirst({
      where: { id: featureId, projectId },
    });
    if (!feature) {
      return NextResponse.json(
        { error: "Feature not found in this project" },
        { status: 400 },
      );
    }
  }

  const runAtDate = runAt ? new Date(runAt) : null;
  const schedule = await prisma.taskSchedule.create({
    data: {
      projectId,
      featureId: featureId ?? null,
      prompt: prompt?.trim() || null,
      provider,
      ephemeral,
      cron: cron ?? null,
      runAt: runAtDate,
      nextRunAt: computeNextRunAt({
        cron: cron ?? null,
        runAt: runAtDate,
        lastRunAt: null,
      }),
    },
    include: { feature: { select: { title: true } } },
  });
  return NextResponse.json(schedule, { status: 201 });
}
