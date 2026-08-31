import { NextRequest, NextResponse } from "next/server";
import { listGroupsForAccount } from "@/services/gitlab";

/**
 * Groups on this server, subgroups included.
 *
 * The subgroups are the point: on an instance organised by team rather than by
 * repo, `civo/dashboard` is the useful unit of import and `civo` is 3476 issues.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ accountId: string }> },
) {
  try {
    const { accountId } = await params;
    const search = req.nextUrl.searchParams.get("search") ?? undefined;
    return NextResponse.json(await listGroupsForAccount(accountId, search));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
