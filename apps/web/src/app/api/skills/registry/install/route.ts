import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { installRegistrySkill, SkillInstallError } from "@/lib/skill-install";
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
  try {
    const skill = await installRegistrySkill(parsed.data.id, await getActiveWorkspaceId());
    return NextResponse.json(skill, { status: 201 });
  } catch (err) {
    if (err instanceof SkillInstallError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }
}
