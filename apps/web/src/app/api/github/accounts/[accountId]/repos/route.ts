import { NextRequest, NextResponse } from "next/server";
import { listReposForAccount } from "@/services/github";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ accountId: string }> }
) {
  try {
    const { accountId } = await params;
    const page = Number(req.nextUrl.searchParams.get("page") ?? "1");
    const repos = await listReposForAccount(accountId, page);
    return NextResponse.json(repos);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
