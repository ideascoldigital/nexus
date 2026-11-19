import { Prisma, prisma } from "@nexux/db";
import { NextRequest, NextResponse } from "next/server";
import { enqueueBotPrompt } from "@/lib/bot-manager";
import { buildIntroPrompt } from "@/lib/bot-intro";
import { botActivity, botDataFor, botInputSchema, botPreview } from "@/lib/bot-view";

export const dynamic = "force-dynamic";

/** Every bot with what its computer is doing right now. */
export async function GET() {
  const bots = await prisma.bot.findMany({
    orderBy: { createdAt: "asc" },
    include: {
      sessions: { orderBy: { createdAt: "desc" }, take: 1 },
      runs: {
        orderBy: { createdAt: "desc" },
        take: 1,
        select: { prompt: true, status: true, result: true, error: true, needsInput: true, createdAt: true, finishedAt: true },
      },
      _count: { select: { runs: { where: { status: { in: ["queued", "running"] } } } } },
    },
  });
  return NextResponse.json(
    bots.map(({ sessions, runs, _count, ...bot }) => {
      const latest = sessions[0] ?? null;
      const last = runs[0] ?? null;
      return {
        ...bot,
        activity: botActivity(latest, _count.runs),
        lastActivityAt: latest?.lastActivityAt ?? null,
        // The list reads like a chat inbox: the latest message and when it landed.
        preview: botPreview(last),
        previewAt: last ? (last.finishedAt ?? last.createdAt) : null,
        needsInput: last?.status === "completed" && last.needsInput,
      };
    }),
  );
}

export async function POST(req: NextRequest) {
  const parsed = botInputSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  const bot = await prisma.bot.create({ data: botDataFor(parsed.data, Prisma.DbNull) as Prisma.BotCreateInput });
  // `?intro=0` skips the greeting — imports create many bots at once, and each
  // greeting wakes a computer.
  if (req.nextUrl.searchParams.get("intro") === "0") return NextResponse.json(bot, { status: 201 });
  // A new teammate says hi first: it wakes its computer and introduces itself
  // with a "where do we start?" question. Best effort — without Docker the bot
  // still exists, it just waits for your first message.
  try {
    await enqueueBotPrompt(bot.id, await buildIntroPrompt(bot));
  } catch (err) {
    console.warn("[bots] intro skipped:", err instanceof Error ? err.message : err);
  }
  return NextResponse.json(bot, { status: 201 });
}
