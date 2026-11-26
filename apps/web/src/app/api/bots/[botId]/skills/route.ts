import { prisma } from "@nexux/db";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { installRegistrySkill, SkillInstallError } from "@/lib/skill-install";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ botId: string }> };

/**
 * A bot's skills (spec 38): the library it can pick from — its workspace's
 * skills plus the machine-wide ones in the default workspace, its own winning
 * a name clash — each marked loaded or not. Loaded skills go into its
 * computer's ~/.claude/skills before its next prompt.
 */
async function library(bot: { id: string; workspaceId: string }) {
  const [rows, loaded] = await Promise.all([
    prisma.skill.findMany({
      where: { workspaceId: { in: [bot.workspaceId, "ws-default"] } },
      select: { id: true, name: true, description: true, source: true, workspaceId: true },
      orderBy: { name: "asc" },
    }),
    prisma.botSkill.findMany({ where: { botId: bot.id }, select: { skillId: true } }),
  ]);
  const on = new Set(loaded.map((l) => l.skillId));
  const byName = new Map<string, (typeof rows)[number]>();
  for (const row of rows) {
    const seen = byName.get(row.name);
    if (!seen || row.workspaceId === bot.workspaceId || on.has(row.id)) byName.set(row.name, row);
  }
  return [...byName.values()].map((s) => ({
    id: s.id,
    name: s.name,
    description: s.description,
    source: s.source,
    loaded: on.has(s.id),
  }));
}

async function findBot(botId: string) {
  return prisma.bot.findUnique({ where: { id: botId }, select: { id: true, workspaceId: true } });
}

const notFound = () => NextResponse.json({ error: "Bot not found" }, { status: 404 });

export async function GET(_req: NextRequest, { params }: Params) {
  const bot = await findBot((await params).botId);
  if (!bot) return notFound();
  return NextResponse.json({ skills: await library(bot) });
}

const putSchema = z.object({ skillIds: z.array(z.string().min(1)).max(200) });

/** Replace what the bot has loaded. Only skills in its library count. */
export async function PUT(req: NextRequest, { params }: Params) {
  const bot = await findBot((await params).botId);
  if (!bot) return notFound();
  const parsed = putSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "skillIds is required" }, { status: 400 });
  const allowed = new Set((await library(bot)).map((s) => s.id));
  const wanted = [...new Set(parsed.data.skillIds)];
  const unknown = wanted.filter((id) => !allowed.has(id));
  if (unknown.length) return NextResponse.json({ error: "Unknown skill" }, { status: 400 });
  await prisma.$transaction([
    prisma.botSkill.deleteMany({ where: { botId: bot.id, skillId: { notIn: wanted } } }),
    ...wanted.map((skillId) =>
      prisma.botSkill.upsert({
        where: { botId_skillId: { botId: bot.id, skillId } },
        create: { botId: bot.id, skillId },
        update: {},
      }),
    ),
  ]);
  return NextResponse.json({ skills: await library(bot) });
}

const postSchema = z.object({ registryId: z.string().min(3) });

/**
 * Install a skills.sh skill into the library and load it on this bot. One the
 * library already has under that name is loaded as it is.
 */
export async function POST(req: NextRequest, { params }: Params) {
  const bot = await findBot((await params).botId);
  if (!bot) return notFound();
  const parsed = postSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "registryId is required" }, { status: 400 });
  let skillId: string;
  try {
    skillId = (await installRegistrySkill(parsed.data.registryId, bot.workspaceId)).id;
  } catch (err) {
    const reusable =
      err instanceof SkillInstallError &&
      err.existing &&
      [bot.workspaceId, "ws-default"].includes(err.existing.workspaceId);
    if (!reusable) {
      const status = err instanceof SkillInstallError ? err.status : 500;
      return NextResponse.json({ error: err instanceof Error ? err.message : "Install failed" }, { status });
    }
    skillId = (err as SkillInstallError).existing!.id;
  }
  await prisma.botSkill.upsert({
    where: { botId_skillId: { botId: bot.id, skillId } },
    create: { botId: bot.id, skillId },
    update: {},
  });
  return NextResponse.json({ skills: await library(bot) }, { status: 201 });
}
