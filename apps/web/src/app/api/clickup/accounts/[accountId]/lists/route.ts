import { NextRequest, NextResponse } from "next/server";
import { listLists } from "@/services/clickup";

export const dynamic = "force-dynamic";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ accountId: string }> }
) {
  try {
    const { accountId } = await params;
    const spaceId = req.nextUrl.searchParams.get("spaceId");
    if (!spaceId) {
      return NextResponse.json({ error: "spaceId is required" }, { status: 400 });
    }
    const lists = await listLists(accountId, spaceId);
    return NextResponse.json(lists);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
