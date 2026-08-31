import { NextResponse } from "next/server";
import { listTeams } from "@/services/clickup";

export const dynamic = "force-dynamic";

/**
 * Authorized workspaces for an account — the first level of the picker's
 * cascade, live like the spaces and lists below it rather than read from the
 * copy in `metadata.teams`. See D-54.
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ accountId: string }> }
) {
  try {
    const { accountId } = await params;
    return NextResponse.json(await listTeams(accountId));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
