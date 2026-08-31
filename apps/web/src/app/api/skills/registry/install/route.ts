import { prisma } from "@nexux/db";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import fs from "node:fs/promises";
import path from "node:path";
import { homeDir } from "@nexux/config";
import { resolveRegistrySkill } from "@/lib/skills-registry";
import { getActiveWorkspaceId } from "@/lib/workspace";

export const dynamic = "force-dynamic";

const schema = z.object({ id: z.string().min(3) });

/**
 * Install a skills.sh skill: fetch its SKILL.md from GitHub, write it under
 * ~/.claude/skills/<name>/ (same layout as custom skills) and register it in
 * the active workspace's catalog with source "skills.sh".
 */
export async function POST(req: NextRequest) {
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "id is required" }, { status: 400 });
  }

  const workspaceId = await getActiveWorkspaceId();

  let resolved;
  try {
    resolved = await resolveRegistrySkill(parsed.data.id);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Resolve failed";
    return NextResponse.json({ error: message }, { status: 502 });
  }

  const existing = await prisma.skill.findUnique({
    where: { name: resolved.name },
  });
  if (existing) {
    return NextResponse.json(
      {
        error:
          existing.workspaceId === workspaceId
            ? "Skill already installed in this workspace"
            : "A skill with this name exists in another workspace",
      },
      { status: 409 },
    );
  }

  const skillDir = path.join(homeDir(), ".claude", "skills", resolved.name);
  await fs.mkdir(skillDir, { recursive: true });
  const skillFile = path.join(skillDir, "SKILL.md");
  await fs.writeFile(skillFile, resolved.content, "utf8");

  const skill = await prisma.skill.create({
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

  return NextResponse.json(skill, { status: 201 });
}
