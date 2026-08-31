/**
 * Check one repository out on this machine.
 *
 * Held open rather than returning immediately like host provisioning does: a
 * clone is seconds to a couple of minutes, the caller has nothing to do until
 * it lands, and polling machinery for something that short is more moving parts
 * than the wait it saves.
 */

import { NextRequest, NextResponse } from "next/server";

import { cloneRepository } from "@/lib/repo-clone";

type Params = { params: Promise<{ projectId: string; repoId: string }> };

export const dynamic = "force-dynamic";
export const maxDuration = 600;

export async function POST(req: NextRequest, { params }: Params) {
  const { repoId } = await params;
  // `?sync=1` pulls a checkout that is already there; without it an existing
  // one is confirmed and left untouched.
  const sync = req.nextUrl.searchParams.get("sync") === "1";
  try {
    const result = await cloneRepository(repoId, { sync });
    // A clone that failed is reported as a 200 carrying `status: "error"`: the
    // row was updated, the message is for the user, and nothing about the
    // request was malformed.
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Could not clone the repository" },
      { status: 400 },
    );
  }
}
