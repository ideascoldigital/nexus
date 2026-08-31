import { NextRequest, NextResponse } from "next/server";
import { getGitLabProject, listProjectsForAccount } from "@/services/gitlab";

/**
 * Projects on this server the token can see.
 *
 * `?path=` resolves a single project instead of listing: on an instance with
 * thousands of projects the search may still not surface the one the user
 * wants, and pasting `group/subgroup/project` always does.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ accountId: string }> },
) {
  try {
    const { accountId } = await params;
    const path = req.nextUrl.searchParams.get("path");
    if (path) {
      return NextResponse.json([await getGitLabProject(accountId, path)]);
    }
    const search = req.nextUrl.searchParams.get("search") ?? undefined;
    return NextResponse.json(await listProjectsForAccount(accountId, search));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
