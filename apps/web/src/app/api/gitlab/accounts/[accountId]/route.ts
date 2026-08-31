import { NextRequest, NextResponse } from "next/server";
import {
  deleteGitLabAccount,
  revalidateGitLabAccount,
} from "@/services/gitlab";

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ accountId: string }> },
) {
  try {
    const { accountId } = await params;
    await deleteGitLabAccount(accountId);
    return NextResponse.json({ success: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

// PATCH — re-validate the token against the instance and refresh the snapshot.
export async function PATCH(
  _req: NextRequest,
  { params }: { params: Promise<{ accountId: string }> },
) {
  try {
    const { accountId } = await params;
    return NextResponse.json(await revalidateGitLabAccount(accountId));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // The service already marked the account as `error`; the status code just
    // tells the card whether to blame the token or the instance.
    const status = message.includes("401") ? 401 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
