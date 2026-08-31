import { prisma } from "@nexux/db";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { computeNextRunAt } from "@/lib/task-scheduler";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ projectId: string; scheduleId: string }> };

const patchSchema = z.object({
  enabled: z.boolean().optional(),
});

// PATCH — enable/disable. Re-enabling recomputes the next firing.
export async function PATCH(req: NextRequest, { params }: Params) {
  const { projectId, scheduleId } = await params;
  const parsed = patchSchema.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  const schedule = await prisma.taskSchedule.findFirst({
    where: { id: scheduleId, projectId },
  });
  if (!schedule) {
    return NextResponse.json({ error: "Schedule not found" }, { status: 404 });
  }

  const enabled = parsed.data.enabled ?? schedule.enabled;
  const updated = await prisma.taskSchedule.update({
    where: { id: scheduleId },
    data: {
      enabled,
      nextRunAt: enabled
        ? computeNextRunAt({
            cron: schedule.cron,
            runAt: schedule.runAt,
            lastRunAt: schedule.lastRunAt,
          })
        : null,
    },
    include: { feature: { select: { title: true } } },
  });
  return NextResponse.json(updated);
}

export async function DELETE(_req: NextRequest, { params }: Params) {
  const { projectId, scheduleId } = await params;
  const schedule = await prisma.taskSchedule.findFirst({
    where: { id: scheduleId, projectId },
  });
  if (!schedule) {
    return NextResponse.json({ error: "Schedule not found" }, { status: 404 });
  }
  await prisma.taskSchedule.delete({ where: { id: scheduleId } });
  return NextResponse.json({ ok: true });
}
