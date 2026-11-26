import { NextRequest, NextResponse } from "next/server";
import { resolveRegistrySkill } from "@/lib/skills-registry";

export const dynamic = "force-dynamic";

/** Full SKILL.md for a registry id — powers the preview pane. */
export async function GET(req: NextRequest) {
  const id = new URL(req.url).searchParams.get("id");
  if (!id) {
    return NextResponse.json({ error: "id is required" }, { status: 400 });
  }
  try {
    // The folder's files are for installing; the preview only shows SKILL.md.
    const skill = await resolveRegistrySkill(id);
    delete skill.files;
    return NextResponse.json(skill);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Resolve failed";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
