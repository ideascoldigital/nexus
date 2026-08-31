import { NextRequest, NextResponse } from "next/server";
import { getLocalGitLabEpics } from "@/services/gitlab";

/** Cached epics for a group (descendants included). */
export async function GET(req: NextRequest) {
  try {
    const { searchParams } = req.nextUrl;
    const accountId = searchParams.get("accountId");
    const groupId = Number(searchParams.get("groupId"));
    const groupPath = searchParams.get("groupPath");
    const state = searchParams.get("state") ?? "opened";
    const search = searchParams.get("search") ?? undefined;

    if (!accountId || !Number.isInteger(groupId) || groupId <= 0 || !groupPath) {
      return NextResponse.json(
        { error: "accountId, a numeric groupId and groupPath are required" },
        { status: 400 },
      );
    }

    const epics = await getLocalGitLabEpics(accountId, groupId, groupPath, {
      state: state === "all" ? undefined : state,
      search,
    });
    return NextResponse.json(epics);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
