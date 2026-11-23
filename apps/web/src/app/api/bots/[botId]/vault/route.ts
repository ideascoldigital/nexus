import { prisma } from "@nexux/db";
import { NextRequest, NextResponse } from "next/server";
import { checkVault } from "@/lib/bot-vault-access";
import { botMayUse, FILLABLE, toPublicItem, type VaultType } from "@/lib/vault-items";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ botId: string }> };

/**
 * vault_list, for the vault MCP server inside a bot's computer (spec 32): the
 * entries this bot may use, public parts only. Needs the token of a prompt the
 * bot is running right now.
 */
export async function GET(req: NextRequest, { params }: Params) {
  const { botId } = await params;
  if (!checkVault(req.headers.get("x-nexux-vault-token"), botId)) {
    return NextResponse.json({ error: "vault: not available outside a running task" }, { status: 401 });
  }
  const rows = await prisma.vaultItem.findMany({ orderBy: [{ type: "asc" }, { name: "asc" }] });
  return NextResponse.json(
    rows
      .filter((r) => botMayUse(r, botId) && (FILLABLE[r.type as VaultType] ?? []).length > 0)
      .map((r) => {
        const p = toPublicItem(r);
        return {
          name: p.name,
          type: p.type,
          websites: p.websites.length ? p.websites : undefined,
          username: p.username ?? undefined,
          hint: p.hint ?? undefined,
          fields: p.filled.filter((f) => FILLABLE[p.type].includes(f)),
        };
      }),
  );
}
