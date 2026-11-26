import { prisma } from "@nexux/db";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { botBootProgress, deleteBotConversation, enqueueBotPrompt } from "@/lib/bot-manager";
import { handoffPrefix } from "@/lib/bot-handoffs";
import { shapeRoutine, shapeRun, shapeSession, shapeThreadReply } from "@/lib/bot-view";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ botId: string }> };

/**
 * The bot's chat: its latest session (the computer panel) and its last 100
 * prompts, oldest first. Each run carries its sessionId so the UI can mark
 * where a new computer — and a fresh Claude memory — began.
 */
export async function GET(_req: NextRequest, { params }: Params) {
  const { botId } = await params;
  const bot = await prisma.bot.findUnique({ where: { id: botId } });
  if (!bot) return NextResponse.json({ error: "Bot not found" }, { status: 404 });

  const [session, runs, routines, handed] = await Promise.all([
    prisma.botSession.findFirst({ where: { botId }, orderBy: { createdAt: "desc" } }),
    prisma.botRun.findMany({ where: { botId }, orderBy: { createdAt: "desc" }, take: 100 }),
    prisma.botRoutine.findMany({ where: { botId }, orderBy: { createdAt: "asc" } }),
    // Work this bot handed to teammates: their side shows as threads here.
    prisma.botRun.findMany({
      where: { prompt: { startsWith: handoffPrefix(botId) } },
      orderBy: { createdAt: "desc" },
      take: 100,
      select: { id: true, botId: true, prompt: true, status: true, result: true, error: true, createdAt: true, finishedAt: true },
    }),
  ]);
  return NextResponse.json({
    bot,
    session: shapeSession(session, session ? botBootProgress(session.id) : null),
    runs: runs.reverse().map(shapeRun),
    routines: routines.map(shapeRoutine),
    threads: handed.reverse().flatMap(shapeThreadReply),
  });
}

const promptSchema = z.object({ prompt: z.string().trim().min(1).max(50_000) });

/** Ask the bot something. Boots its computer first if none is running. */
export async function POST(req: NextRequest, { params }: Params) {
  const { botId } = await params;
  const parsed = promptSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "prompt is required" }, { status: 400 });
  }
  const exists = await prisma.bot.findUnique({ where: { id: botId }, select: { id: true } });
  if (!exists) return NextResponse.json({ error: "Bot not found" }, { status: 404 });
  try {
    const run = await enqueueBotPrompt(botId, parsed.data.prompt);
    return NextResponse.json(shapeRun(run), { status: 202 });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 409 },
    );
  }
}

/**
 * Delete the conversation: every message and the files the bot handed over in
 * them (spec 37). The bot forgets with it. Its routines, its sign-ins and the
 * shared workspace stay — they are not part of the chat.
 */
export async function DELETE(_req: NextRequest, { params }: Params) {
  const { botId } = await params;
  const exists = await prisma.bot.findUnique({ where: { id: botId }, select: { id: true } });
  if (!exists) return NextResponse.json({ error: "Bot not found" }, { status: 404 });
  const deleted = await deleteBotConversation(botId);
  return NextResponse.json({ ok: true, deleted });
}
