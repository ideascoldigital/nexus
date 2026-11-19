import { prisma } from "@nexux/db";
import { NextRequest, NextResponse } from "next/server";

import { enqueueBotPrompt } from "@/lib/bot-manager";
import { describeCron, renderRoutinePrompt } from "@/lib/bot-routines";
import { shapeRun } from "@/lib/bot-view";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ botId: string; routineId: string }> };

/** Run a routine now, off-schedule. Its next scheduled run is unchanged. */
export async function POST(_req: NextRequest, { params }: Params) {
  const { botId, routineId } = await params;
  const r = await prisma.botRoutine.findUnique({ where: { id: routineId } });
  if (!r || r.botId !== botId) return NextResponse.json({ error: "Routine not found" }, { status: 404 });
  try {
    const run = await enqueueBotPrompt(botId, renderRoutinePrompt({ ...r, label: describeCron(r.cron) }));
    await prisma.botRoutine.update({ where: { id: r.id }, data: { lastRunAt: new Date() } });
    return NextResponse.json(shapeRun(run), { status: 202 });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 409 });
  }
}
