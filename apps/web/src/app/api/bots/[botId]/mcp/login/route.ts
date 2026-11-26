import { prisma } from "@nexux/db";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { signInBotMcp } from "@/lib/bot-mcp-auth";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ botId: string }> };

const schema = z.object({ server: z.string().trim().min(1).max(40) });

/**
 * Start the OAuth sign-in for one of the bot's MCP servers on its own screen
 * (spec 37): a terminal window runs `claude mcp login`, which opens the
 * consent page in the bot's browser. Returns as soon as it is on screen — the
 * user takes control and approves there.
 */
export async function POST(req: NextRequest, { params }: Params) {
  const { botId } = await params;
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "server is required" }, { status: 400 });
  const exists = await prisma.bot.findUnique({ where: { id: botId }, select: { id: true } });
  if (!exists) return NextResponse.json({ error: "Bot not found" }, { status: 404 });
  try {
    await signInBotMcp(botId, parsed.data.server);
    return NextResponse.json({ ok: true }, { status: 202 });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 409 },
    );
  }
}
