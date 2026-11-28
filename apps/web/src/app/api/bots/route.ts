import { Prisma, prisma } from "@nexux/db";
import { NextRequest, NextResponse } from "next/server";
import { enqueueBotPrompt } from "@/lib/bot-manager";
import { buildIntroPrompt } from "@/lib/bot-intro";
import {
  botActiveAt,
  botActivity,
  botDataFor,
  botInputSchema,
  botPreview,
  byRecentActivity,
} from "@/lib/bot-view";
import { missingEndpoint } from "@/lib/docker-endpoints";
import { getActiveWorkspaceId } from "@/lib/workspace";
import { NEXUS_KIND, startNexusChat } from "@/lib/nexus-assistant";

export const dynamic = "force-dynamic";

/** The active workspace's bots, most recent activity first, with what each computer is doing right now. */
export async function GET() {
  const workspaceId = await getActiveWorkspaceId();
  const bots = await prisma.bot.findMany({
    // Strictly this workspace's team — unlike agents and skills, which are
    // catalogs a workspace inherits from the default one. A bot is a running
    // teammate with a computer and a chat history, so seeing it in a workspace
    // it was not hired into would be a surprise, not a convenience.
    where: { workspaceId },
    orderBy: { createdAt: "asc" },
    include: {
      sessions: { orderBy: { createdAt: "desc" }, take: 1 },
      runs: {
        orderBy: { createdAt: "desc" },
        take: 1,
        select: {
          prompt: true,
          status: true,
          result: true,
          error: true,
          needsInput: true,
          createdAt: true,
          finishedAt: true,
        },
      },
      _count: {
        select: { runs: { where: { status: { in: ["queued", "running"] } } } },
      },
    },
  });
  return NextResponse.json(
    bots
      .map((b) => ({
        b,
        activeAt: botActiveAt(b, b.runs[0] ?? null),
        createdAt: b.createdAt,
      }))
      .sort(byRecentActivity)
      .map(({ b }) => b)
      .map(({ sessions, runs, _count, ...bot }) => {
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
  const body = await req.json().catch(() => null);
  // A project chat (spec 39): Nexus's own tools, no computer. It creates the
  // project with you and then belongs to it.
  if (body && typeof body === "object" && (body as { kind?: unknown }).kind === NEXUS_KIND) {
    const parsedChat = botInputSchema.pick({ name: true, color: true, shape: true }).partial().safeParse(body);
    if (!parsedChat.success) {
      return NextResponse.json({ error: parsedChat.error.flatten() }, { status: 400 });
    }
    const chat = await prisma.bot.create({
      data: {
        workspaceId: await getActiveWorkspaceId(),
        kind: NEXUS_KIND,
        name: parsedChat.data.name || "New project",
        role: "New project",
        color: parsedChat.data.color ?? "#6366f1",
        shape: parsedChat.data.shape ?? "hexagon",
      },
    });
    void startNexusChat(chat.id).catch((err) =>
      console.warn("[nexus] intro skipped:", err instanceof Error ? err.message : err),
    );
    return NextResponse.json(chat, { status: 201 });
  }
  const parsed = botInputSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.flatten() },
      { status: 400 },
    );
  }
  if (await missingEndpoint(parsed.data.dockerEndpointId)) {
    return NextResponse.json(
      { error: "That Docker endpoint no longer exists." },
      { status: 400 },
    );
  }
  const workspaceId = await getActiveWorkspaceId();
  const bot = await prisma.bot.create({
    data: {
      ...botDataFor(parsed.data, Prisma.DbNull),
      workspaceId,
    } as Prisma.BotCreateInput,
  });
  // `?intro=0` skips the greeting — imports create many bots at once, and each
  // greeting wakes a computer.
  if (req.nextUrl.searchParams.get("intro") === "0")
    return NextResponse.json(bot, { status: 201 });
  // A new teammate says hi first: it wakes its computer and introduces itself
  // with a "where do we start?" question.
  //
  // Deliberately not awaited. Waking a computer is slow in ways that have
  // nothing to do with creating a bot: a daemon that has never built the bot
  // image builds it now (minutes), and an endpoint pays an SSH handshake
  // before that — one that fails on a 20s timeout when the machine is asleep,
  // which is 20s of a dialog that has nothing left to do. The bot exists
  // either way; the greeting arrives when it arrives, or not at all.
  void buildIntroPrompt(bot)
    .then((prompt) => enqueueBotPrompt(bot.id, prompt))
    .catch((err) =>
      console.warn(
        "[bots] intro skipped:",
        err instanceof Error ? err.message : err,
      ),
    );
  return NextResponse.json(bot, { status: 201 });
}
