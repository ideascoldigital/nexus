import { prisma } from "@nexux/db";
import { NextRequest, NextResponse } from "next/server";

import { isValidRoutineCron, nextRoutineRun } from "@/lib/bot-routine-store";
import { routineInputSchema, shapeRoutine } from "@/lib/bot-view";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ botId: string }> };

export async function GET(_req: NextRequest, { params }: Params) {
  const { botId } = await params;
  const routines = await prisma.botRoutine.findMany({ where: { botId }, orderBy: { createdAt: "asc" } });
  return NextResponse.json(routines.map(shapeRoutine));
}

/** Create a routine by hand (the bot creates them from the chat too). */
export async function POST(req: NextRequest, { params }: Params) {
  const { botId } = await params;
  const parsed = routineInputSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  if (!isValidRoutineCron(parsed.data.cron)) {
    return NextResponse.json({ error: `Invalid schedule: ${parsed.data.cron}` }, { status: 400 });
  }
  const bot = await prisma.bot.findUnique({ where: { id: botId }, select: { id: true } });
  if (!bot) return NextResponse.json({ error: "Bot not found" }, { status: 404 });
  const enabled = parsed.data.enabled ?? true;
  const routine = await prisma.botRoutine.create({
    data: { ...parsed.data, botId, enabled, nextRunAt: enabled ? nextRoutineRun(parsed.data.cron) : null },
  });
  return NextResponse.json(shapeRoutine(routine), { status: 201 });
}
