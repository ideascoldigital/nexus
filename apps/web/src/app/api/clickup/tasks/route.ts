import { NextRequest, NextResponse } from "next/server";
import { getLocalTasks } from "@/services/clickup";

export const dynamic = "force-dynamic";

/** Cached ClickUp tasks — reads the local cache, never the ClickUp API. */
export async function GET(req: NextRequest) {
  try {
    const sp = req.nextUrl.searchParams;
    const accountId = sp.get("accountId");
    const listId = sp.get("listId");
    if (!accountId || !listId) {
      return NextResponse.json(
        { error: "accountId and listId are required" },
        { status: 400 }
      );
    }
    const tasks = await getLocalTasks(accountId, listId, {
      search: sp.get("search") ?? undefined,
      includeClosed: sp.get("includeClosed") === "true",
    });
    return NextResponse.json(tasks);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
