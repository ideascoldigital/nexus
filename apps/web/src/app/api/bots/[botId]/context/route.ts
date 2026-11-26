import { prisma } from "@nexux/db";
import { NextRequest, NextResponse } from "next/server";
import { clearBotContext } from "@/lib/bot-manager";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ botId: string }> };

/**
 * Forget the conversation so far (spec 37): the bot's next message starts a
 * fresh Claude and nothing said before now is replayed to it. The chat keeps
 * every message and the computer is left exactly as it is.
 */
export async function DELETE(_req: NextRequest, { params }: Params) {
  const { botId } = await params;
  const exists = await prisma.bot.findUnique({ where: { id: botId }, select: { id: true } });
  if (!exists) return NextResponse.json({ error: "Bot not found" }, { status: 404 });
  const clearedAt = await clearBotContext(botId);
  return NextResponse.json({ clearedAt });
}
