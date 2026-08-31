/**
 * Check out every repository of a project — what a freshly imported install
 * needs, where each project arrives with URLs and paths but no working copies.
 */

import { NextRequest, NextResponse } from "next/server";

import { cloneProjectRepositories } from "@/lib/repo-clone";

type Params = { params: Promise<{ projectId: string }> };

export const dynamic = "force-dynamic";
export const maxDuration = 600;

export async function POST(req: NextRequest, { params }: Params) {
  const { projectId } = await params;
  // `?sync=1` also pulls the repos that are already checked out.
  const sync = req.nextUrl.searchParams.get("sync") === "1";
  try {
    const results = await cloneProjectRepositories(projectId, { sync });
    // Partial success is the normal outcome — one private repo without a token
    // among five public ones — so every result is returned and the caller
    // decides what to say.
    return NextResponse.json({ results });
  } catch (err) {
    return NextResponse.json(
      {
        error:
          err instanceof Error ? err.message : "Could not clone the repositories",
      },
      { status: 400 },
    );
  }
}
