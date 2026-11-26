import { prisma } from "@nexux/db";
import { NextRequest, NextResponse } from "next/server";
import { restartBotSession } from "@/lib/bot-manager";
import { shapeSession } from "@/lib/bot-view";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ botId: string }> };

/**
 * A fresh computer, now (spec 37): the old one is deleted and a new one boots.
 * The conversation is kept; queued prompts move to the new computer, and
 * anything that was running stops with it.
 */
export async function POST(_req: NextRequest, { params }: Params) {
  const { botId } = await params;
  const exists = await prisma.bot.findUnique({ where: { id: botId }, select: { id: true } });
  if (!exists) return NextResponse.json({ error: "Bot not found" }, { status: 404 });
  try {
    const session = await restartBotSession(botId);
    return NextResponse.json(shapeSession(session), { status: 202 });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 409 },
    );
  }
}
