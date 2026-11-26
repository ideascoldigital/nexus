// The skills a bot has loaded (spec 38), read from the database as the files
// that go into its computer. Server-side only.

import { prisma } from "@nexux/db";
import { BOT_SKILL_NAME, type BotSkillFiles } from "@nexux/sandbox";
import { skillFiles } from "@/lib/bot-skill-files";

/** The skills a bot has loaded, ready for its computer. Names unsafe as a folder are left out. */
export async function botSkillFiles(botId: string): Promise<BotSkillFiles[]> {
  const rows = await prisma.botSkill.findMany({
    where: { botId },
    include: { skill: { select: { name: true, description: true, path: true, body: true } } },
    orderBy: { createdAt: "asc" },
  });
  const usable = rows.map((r) => r.skill).filter((s) => BOT_SKILL_NAME.test(s.name));
  return Promise.all(usable.map(skillFiles));
}
