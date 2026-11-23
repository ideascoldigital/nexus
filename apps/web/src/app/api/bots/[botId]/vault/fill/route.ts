import { prisma } from "@nexux/db";
import { typeIntoBotBrowser } from "@nexux/sandbox";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { checkVault } from "@/lib/bot-vault-access";
import { botMayUse, FILLABLE, type VaultType } from "@/lib/vault-items";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ botId: string }> };

const schema = z.object({ entry: z.string().trim().min(1).max(200), field: z.string().min(1).max(20) });

function valueFor(field: string, secret: Record<string, unknown>): string | null {
  const v = secret[field];
  return typeof v === "string" && v ? v : null;
}

/**
 * vault_fill (spec 32): type one vault value into the field focused in the
 * bot's browser. The value goes Nexus → `docker exec` stdin → CDP, never
 * through Claude or the run log. The typing script refuses a password outside
 * a password field, a login outside its websites, a card outside https.
 */
export async function POST(req: NextRequest, { params }: Params) {
  const { botId } = await params;
  const grant = checkVault(req.headers.get("x-nexux-vault-token"), botId);
  if (!grant) return NextResponse.json({ error: "vault: not available outside a running task" }, { status: 401 });
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "vault_fill needs an entry and a field" }, { status: 400 });
  const { entry, field } = parsed.data;

  const want = entry.toLowerCase();
  const items = (await prisma.vaultItem.findMany()).filter((i) => botMayUse(i, botId));
  const item =
    items.find((i) => i.name.toLowerCase() === want) ??
    items.find((i) => i.label?.toLowerCase() === want) ??
    items.find((i) => Array.isArray(i.websites) && (i.websites as string[]).some((w) => w.toLowerCase() === want));
  if (!item) return NextResponse.json({ error: `No vault entry "${entry}" you may use. Call vault_list.` }, { status: 404 });
  const type = item.type as VaultType;
  if (!(FILLABLE[type] ?? []).includes(field)) {
    return NextResponse.json(
      { error: `"${field}" can't be typed from a ${type}${type === "login" ? " (type the username yourself; only the password comes from the vault)" : ""}.` },
      { status: 400 },
    );
  }
  const value = valueFor(field, (item.secret ?? {}) as Record<string, unknown>);
  if (!value) return NextResponse.json({ error: `The entry "${item.name}" has no ${field}.` }, { status: 404 });

  const typed = await typeIntoBotBrowser(
    grant.container,
    {
      text: value,
      password: type === "login" && field === "password",
      hosts: type === "login" ? ((item.websites as string[] | null) ?? []) : undefined,
      https: type === "card",
    },
    { host: grant.dockerHost },
  );
  if (!typed.ok) return NextResponse.json({ error: typed.reason ?? "Could not type it." }, { status: 409 });
  await prisma.vaultItem.update({ where: { id: item.id }, data: { lastUsedAt: new Date() } });
  console.log(`[vault] ${field} of "${item.name}" typed for bot ${botId} on ${typed.host ?? "?"}`);
  return NextResponse.json({ message: `Typed the ${field} of "${item.name}" into the focused field${typed.host ? ` on ${typed.host}` : ""}.` });
}
