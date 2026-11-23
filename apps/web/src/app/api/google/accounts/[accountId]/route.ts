import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { disconnectGoogleAccount, setGoogleAccountBots } from "@/services/google";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ accountId: string }> };

const schema = z.object({ botIds: z.array(z.string().min(1)).max(200).nullable() });

/** Which bots may use the account; null = every bot. */
export async function PATCH(req: NextRequest, { params }: Params) {
  const { accountId } = await params;
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "botIds must be a list or null" }, { status: 400 });
  const account = await setGoogleAccountBots(accountId, parsed.data.botIds);
  if (!account) return NextResponse.json({ error: "Account not found" }, { status: 404 });
  return NextResponse.json(account);
}

/** Disconnect: revoke at Google and forget the tokens. */
export async function DELETE(_req: NextRequest, { params }: Params) {
  const { accountId } = await params;
  if (!(await disconnectGoogleAccount(accountId))) return NextResponse.json({ error: "Account not found" }, { status: 404 });
  return NextResponse.json({ ok: true });
}
