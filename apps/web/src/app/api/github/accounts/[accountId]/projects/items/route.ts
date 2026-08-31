import { NextRequest, NextResponse } from "next/server";
import { getProjectV2Items } from "@/services/github-projects";

export const dynamic = "force-dynamic";

/** Items of one Project V2 (issues + drafts, normalized; PRs skipped). */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ accountId: string }> }
) {
  try {
    const { accountId } = await params;
    const ghProjectId = req.nextUrl.searchParams.get("ghProjectId");
    if (!ghProjectId) {
      return NextResponse.json(
        { error: "ghProjectId is required" },
        { status: 400 }
      );
    }
    const result = await getProjectV2Items(accountId, ghProjectId);
    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
