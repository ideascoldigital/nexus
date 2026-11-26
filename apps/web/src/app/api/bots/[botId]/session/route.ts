import { prisma } from "@nexux/db";
import { NextRequest, NextResponse } from "next/server";
import { startBotSession, stopBotSession, touchBotSession } from "@/lib/bot-manager";
import { shapeSession } from "@/lib/bot-view";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ botId: string }> };

/** Turn the bot's computer on (no-op if it is already up or booting). */
export async function POST(_req: NextRequest, { params }: Params) {
  const { botId } = await params;
  const exists = await prisma.bot.findUnique({ where: { id: botId }, select: { id: true } });
  if (!exists) return NextResponse.json({ error: "Bot not found" }, { status: 404 });
  try {
    const session = await startBotSession(botId);
    return NextResponse.json(shapeSession(session), { status: 202 });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 409 },
    );
  }
}

/** Turn the computer off: it sleeps, and wakes as itself. Queued and running prompts are canceled. */
export async function DELETE(_req: NextRequest, { params }: Params) {
  const { botId } = await params;
  await stopBotSession(botId);
  return NextResponse.json({ ok: true });
}

/** Heartbeat while you watch or drive the screen — keeps the computer awake. */
export async function PATCH(_req: NextRequest, { params }: Params) {
  const { botId } = await params;
  const alive = await touchBotSession(botId);
  return NextResponse.json({ ok: alive }, { status: alive ? 200 : 404 });
}
