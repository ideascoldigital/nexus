import { NextRequest, NextResponse } from "next/server";
import { searchRegistry } from "@/lib/skills-registry";

export const dynamic = "force-dynamic";

/** Proxy search against skills.sh (the browser can't, CORS). */
export async function GET(req: NextRequest) {
  const q = new URL(req.url).searchParams.get("q")?.trim() ?? "";
  if (q.length < 2) {
    return NextResponse.json({ skills: [] });
  }
  try {
    const skills = await searchRegistry(q);
    return NextResponse.json({ skills: skills.slice(0, 25) });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Search failed";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
