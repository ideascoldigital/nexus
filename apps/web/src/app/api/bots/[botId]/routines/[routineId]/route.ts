import { prisma } from "@nexux/db";
import { NextRequest, NextResponse } from "next/server";

import { isValidRoutineCron, nextRoutineRun } from "@/lib/bot-routine-store";
import { routineInputSchema, shapeRoutine } from "@/lib/bot-view";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ botId: string; routineId: string }> };

async function find(botId: string, routineId: string) {
  const r = await prisma.botRoutine.findUnique({ where: { id: routineId } });
  return r && r.botId === botId ? r : null;
}

/** Edit, pause or resume. */
export async function PATCH(req: NextRequest, { params }: Params) {
  const { botId, routineId } = await params;
  const parsed = routineInputSchema.partial().safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  if (parsed.data.cron !== undefined && !isValidRoutineCron(parsed.data.cron)) {
    return NextResponse.json({ error: `Invalid schedule: ${parsed.data.cron}` }, { status: 400 });
  }
  const existing = await find(botId, routineId);
  if (!existing) return NextResponse.json({ error: "Routine not found" }, { status: 404 });
  const cron = parsed.data.cron ?? existing.cron;
  const enabled = parsed.data.enabled ?? existing.enabled;
  const routine = await prisma.botRoutine.update({
    where: { id: routineId },
    data: { ...parsed.data, nextRunAt: enabled ? nextRoutineRun(cron) : null },
  });
  return NextResponse.json(shapeRoutine(routine));
}

export async function DELETE(_req: NextRequest, { params }: Params) {
  const { botId, routineId } = await params;
  if (!(await find(botId, routineId))) return NextResponse.json({ error: "Routine not found" }, { status: 404 });
  await prisma.botRoutine.delete({ where: { id: routineId } });
  return NextResponse.json({ ok: true });
}
