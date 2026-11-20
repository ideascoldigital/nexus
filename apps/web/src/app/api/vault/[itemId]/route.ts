import { Prisma, prisma } from "@nexux/db";
import { NextRequest, NextResponse } from "next/server";
import { cardLabel, luhnOk, normalizeHost, SECRET_FIELDS, SECRET_NAME, toPublicItem, vaultUpdateSchema, type VaultType } from "@/lib/vault-items";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ itemId: string }> };

/**
 * Edit an entry. Public fields change as given; a secret field given non-empty
 * replaces the stored one (the old value is never sent back, so the form
 * leaves it blank to keep it).
 */
export async function PATCH(req: NextRequest, { params }: Params) {
  const { itemId } = await params;
  const parsed = vaultUpdateSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid entry" }, { status: 400 });
  const item = await prisma.vaultItem.findUnique({ where: { id: itemId } });
  if (!item) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const type = item.type as VaultType;
  const p = parsed.data;

  const data: Prisma.VaultItemUpdateInput = {};
  if (p.name !== undefined) {
    if (type === "secret" && !SECRET_NAME.test(p.name)) {
      return NextResponse.json({ error: "Letters, digits, - _ . (it's how configs reference it)" }, { status: 400 });
    }
    data.name = p.name;
  }
  if (p.hint !== undefined) data.hint = p.hint?.trim() || null;
  if (p.botIds !== undefined) data.botIds = p.botIds?.length ? p.botIds : Prisma.DbNull;
  if (type === "login") {
    if (p.websites !== undefined) {
      const websites = [...new Set(p.websites.map(normalizeHost).filter(Boolean))];
      if (websites.length === 0) return NextResponse.json({ error: "Add the website" }, { status: 400 });
      data.websites = websites;
    }
    if (p.username !== undefined) data.username = p.username?.trim() || null;
  }
  if (p.secret) {
    const allowed = SECRET_FIELDS[type] as readonly string[];
    const changes = Object.fromEntries(Object.entries(p.secret).filter(([k, v]) => allowed.includes(k) && v.length > 0));
    if (type === "card" && changes.number !== undefined) {
      if (!luhnOk(changes.number)) return NextResponse.json({ error: "That card number doesn't look right" }, { status: 400 });
      changes.number = changes.number.replace(/\D/g, "");
      data.label = cardLabel(changes.number);
    }
    if (Object.keys(changes).length) {
      const current = (item.secret ?? {}) as Record<string, string>;
      data.secret = { ...current, ...changes };
    }
  }
  try {
    const row = await prisma.vaultItem.update({ where: { id: itemId }, data });
    return NextResponse.json(toPublicItem(row));
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      return NextResponse.json({ error: "That name is taken" }, { status: 409 });
    }
    throw err;
  }
}

export async function DELETE(_req: NextRequest, { params }: Params) {
  const { itemId } = await params;
  const gone = await prisma.vaultItem.deleteMany({ where: { id: itemId } });
  if (gone.count === 0) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({ ok: true });
}
