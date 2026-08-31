import { NextRequest, NextResponse } from "next/server";
import { resolveRegistryAgent } from "@/lib/agents-registry";

export const dynamic = "force-dynamic";

/** Full agent .md — powers the preview pane. */
export async function GET(req: NextRequest) {
  const path = new URL(req.url).searchParams.get("path");
  if (!path) {
    return NextResponse.json({ error: "path is required" }, { status: 400 });
  }
  try {
    const agent = await resolveRegistryAgent(path);
    return NextResponse.json(agent);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Resolve failed";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
