import { NextRequest, NextResponse } from "next/server";
import {
  deleteClickUpAccount,
  revalidateClickUpAccount,
} from "@/services/clickup";

type Params = { params: Promise<{ accountId: string }> };

export async function PATCH(_req: NextRequest, { params }: Params) {
  try {
    const { accountId } = await params;
    const account = await revalidateClickUpAccount(accountId);
    if (account.status !== "connected") {
      return NextResponse.json(
        { error: "ClickUp rejected the stored token — reconnect the account." },
        { status: 401 }
      );
    }
    return NextResponse.json(account);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = message.includes("not found") ? 404 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}

export async function DELETE(_req: NextRequest, { params }: Params) {
  try {
    const { accountId } = await params;
    await deleteClickUpAccount(accountId);
    return NextResponse.json({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
