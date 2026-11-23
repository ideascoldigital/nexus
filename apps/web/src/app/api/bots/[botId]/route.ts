import { Prisma, prisma } from "@nexux/db";
import { NextRequest, NextResponse } from "next/server";
import { removeBotFiles } from "@/lib/bot-files";
import { removeBotProfile } from "@/lib/bot-workspace";
import { removeCookieSnapshot } from "@/lib/team-cookies";
import { stopBotSession } from "@/lib/bot-manager";
import { botDataFor, botInputSchema } from "@/lib/bot-view";
import { missingEndpoint } from "@/lib/docker-endpoints";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ botId: string }> };

export async function GET(_req: NextRequest, { params }: Params) {
  const { botId } = await params;
  const bot = await prisma.bot.findUnique({ where: { id: botId } });
  if (!bot) return NextResponse.json({ error: "Bot not found" }, { status: 404 });
  return NextResponse.json(bot);
}

export async function PATCH(req: NextRequest, { params }: Params) {
  const { botId } = await params;
  const parsed = botInputSchema.partial().safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  const exists = await prisma.bot.findUnique({ where: { id: botId }, select: { id: true } });
  if (!exists) return NextResponse.json({ error: "Bot not found" }, { status: 404 });
  if (await missingEndpoint(parsed.data.dockerEndpointId)) {
    return NextResponse.json({ error: "That Docker endpoint no longer exists." }, { status: 400 });
  }
  const bot = await prisma.bot.update({ where: { id: botId }, data: botDataFor(parsed.data, Prisma.DbNull) as Prisma.BotUpdateInput });
  return NextResponse.json(bot);
}

/** Deletes the bot, its computer (if one is up) and its chat history. */
export async function DELETE(_req: NextRequest, { params }: Params) {
  const { botId } = await params;
  const exists = await prisma.bot.findUnique({ where: { id: botId }, select: { id: true } });
  if (!exists) return NextResponse.json({ error: "Bot not found" }, { status: 404 });
  await stopBotSession(botId);
  await prisma.bot.delete({ where: { id: botId } });
  removeBotFiles(botId);
  removeBotProfile(botId);
  removeCookieSnapshot(botId);
  return NextResponse.json({ ok: true });
}
