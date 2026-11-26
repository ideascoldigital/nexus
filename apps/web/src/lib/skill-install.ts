// Installing a skills.sh skill into the library: its SKILL.md is fetched from
// GitHub, written under ~/.claude/skills/<name>/ (the layout custom skills use)
// and registered in the workspace's catalog with source "skills.sh".

import fs from "node:fs/promises";
import path from "node:path";
import { prisma, type Skill } from "@nexux/db";
import { homeDir } from "@nexux/config";
import { resolveRegistrySkill } from "@/lib/skills-registry";

export class SkillInstallError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** The skill already in the library under that name, when that is the problem. */
    readonly existing: Skill | null = null,
  ) {
    super(message);
  }
}

export async function installRegistrySkill(id: string, workspaceId: string): Promise<Skill> {
  let resolved;
  try {
    resolved = await resolveRegistrySkill(id);
  } catch (err) {
    throw new SkillInstallError(err instanceof Error ? err.message : "Resolve failed", 502);
  }

  const existing = await prisma.skill.findUnique({ where: { name: resolved.name } });
  if (existing) {
    throw new SkillInstallError(
      existing.workspaceId === workspaceId
        ? "Skill already installed in this workspace"
        : "A skill with this name exists in another workspace",
      409,
      existing,
    );
  }

  const skillDir = path.join(homeDir(), ".claude", "skills", resolved.name);
  await fs.mkdir(skillDir, { recursive: true });
  const skillFile = path.join(skillDir, "SKILL.md");
  // The whole folder when the archive brought it (references, scripts); a
  // path that would leave the folder is skipped.
  for (const f of resolved.files ?? []) {
    const to = path.resolve(skillDir, f.path);
    if (!to.startsWith(skillDir + path.sep)) continue;
    await fs.mkdir(path.dirname(to), { recursive: true });
    await fs.writeFile(to, f.content);
  }
  await fs.writeFile(skillFile, resolved.content, "utf8");

  return prisma.skill.create({
    data: {
      name: resolved.name,
      description: resolved.description || null,
      workspaceId,
      source: "skills.sh",
      scope: "user",
      path: skillFile,
      body: resolved.body,
    },
  });
}
