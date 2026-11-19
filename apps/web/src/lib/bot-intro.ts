// The context a new bot's first message is built from (spec 23): the user's
// first name (git's user.name — Nexux has no profile), their projects, and a
// recent message of theirs for language.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { prisma } from "@nexux/db";

import { INTRO_TAG, isSystemPrompt, renderIntroPrompt } from "@/lib/bot-prompts";

const run = promisify(execFile);

async function firstName(): Promise<string | null> {
  try {
    const { stdout } = await run("git", ["config", "--global", "user.name"], { timeout: 2000 });
    return stdout.trim().split(/\s+/)[0] || null;
  } catch {
    return null;
  }
}

export async function buildIntroPrompt(bot: { role: string | null }): Promise<string> {
  const [userName, projects, recent] = await Promise.all([
    firstName(),
    prisma.project.findMany({
      orderBy: { updatedAt: "desc" },
      take: 12,
      select: { name: true, description: true },
    }),
    prisma.botRun.findMany({
      where: { NOT: { prompt: { startsWith: INTRO_TAG } } },
      orderBy: { createdAt: "desc" },
      take: 5,
      select: { prompt: true },
    }),
  ]);
  const sample = recent.find((r) => !isSystemPrompt(r.prompt))?.prompt ?? null;
  return renderIntroPrompt({ userName, role: bot.role, projects, languageSample: sample });
}
