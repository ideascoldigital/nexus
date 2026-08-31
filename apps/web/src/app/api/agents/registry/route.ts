import { NextRequest, NextResponse } from "next/server";
import { searchRegistryAgents } from "@/lib/agents-registry";

export const dynamic = "force-dynamic";

/** Agent catalog from aitmpl.com — top downloads, filtered by ?q=. */
export async function GET(req: NextRequest) {
  const q = new URL(req.url).searchParams.get("q") ?? "";
  try {
    const agents = await searchRegistryAgents(q);
    return NextResponse.json({ agents });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Registry failed";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
