import { prisma } from "@nexux/db";
import { NextRequest, NextResponse } from "next/server";
import { botMcpStatus } from "@/lib/bot-mcp-auth";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ botId: string }> };

/**
 * The bot's own MCP servers and what each says right now (spec 37) — so a
 * server that wants an OAuth sign-in says so instead of silently failing
 * halfway through a task. Checked from inside the computer, which has to be
 * awake; asleep, the servers are still listed.
 */
export async function GET(_req: NextRequest, { params }: Params) {
  const { botId } = await params;
  const exists = await prisma.bot.findUnique({ where: { id: botId }, select: { id: true } });
  if (!exists) return NextResponse.json({ error: "Bot not found" }, { status: 404 });
  try {
    return NextResponse.json({ servers: await botMcpStatus(botId) });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 409 },
    );
  }
}
