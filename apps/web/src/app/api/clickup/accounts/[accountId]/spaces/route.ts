import { NextRequest, NextResponse } from "next/server";
import { listSpaces } from "@/services/clickup";

export const dynamic = "force-dynamic";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ accountId: string }> }
) {
  try {
    const { accountId } = await params;
    const teamId = req.nextUrl.searchParams.get("teamId");
    if (!teamId) {
      return NextResponse.json({ error: "teamId is required" }, { status: 400 });
    }
    const spaces = await listSpaces(accountId, teamId);
    return NextResponse.json(spaces);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
