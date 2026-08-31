import { prisma } from "@nexux/db";
import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ tokenId: string }> };

/**
 * Revokes a token. Deliberately not a DELETE of the row: the record that a
 * token existed, and when it was last used, is exactly what you want after
 * discovering one leaked. Revoking twice is not an error — the caller's intent
 * ("this must not work") is already satisfied.
 */
export async function DELETE(_req: NextRequest, { params }: Params) {
  const { tokenId } = await params;
  const row = await prisma.apiToken.findUnique({ where: { id: tokenId } });
  if (!row) {
    return NextResponse.json({ error: "Token not found" }, { status: 404 });
  }
  if (row.revokedAt) {
    return NextResponse.json({ ok: true, revokedAt: row.revokedAt });
  }
  const updated = await prisma.apiToken.update({
    where: { id: tokenId },
    data: { revokedAt: new Date() },
  });
  return NextResponse.json({ ok: true, revokedAt: updated.revokedAt });
}
