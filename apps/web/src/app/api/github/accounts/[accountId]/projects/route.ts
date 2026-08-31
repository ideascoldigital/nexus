import { NextRequest, NextResponse } from "next/server";
import { listProjectsV2, resolveProjectV2 } from "@/services/github-projects";

export const dynamic = "force-dynamic";

/**
 * GitHub Projects V2 visible to the account (own + orgs + repo-linked), or —
 * with `?url=` — the single board that URL points at, for boards no listing
 * reaches (another user's, or a private-membership org's).
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ accountId: string }> }
) {
  try {
    const { accountId } = await params;
    const url = req.nextUrl.searchParams.get("url");
    if (url) {
      const project = await resolveProjectV2(accountId, url);
      return NextResponse.json({ projects: [project], warning: null });
    }
    const result = await listProjectsV2(accountId);
    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
