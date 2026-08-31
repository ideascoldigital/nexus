import { NextRequest, NextResponse } from "next/server";
import { getLocalIssues } from "@/services/github";

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = req.nextUrl;
    const accountId = searchParams.get("accountId");
    const owner = searchParams.get("owner");
    const repo = searchParams.get("repo");
    const state = searchParams.get("state") ?? "open";
    const search = searchParams.get("search") ?? undefined;

    if (!accountId || !owner || !repo) {
      return NextResponse.json(
        { error: "accountId, owner and repo are required" },
        { status: 400 }
      );
    }

    const issues = await getLocalIssues(accountId, owner, repo, {
      // "all" means no state filter — passed through it would match nothing,
      // since rows only ever hold "open" or "closed".
      state: state === "all" ? undefined : state,
      search,
    });
    return NextResponse.json(issues);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
