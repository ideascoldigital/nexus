import { Prisma, prisma } from "@nexux/db";
import { NextRequest, NextResponse } from "next/server";
import { itemFromInput, toPublicItem, vaultCreateSchema } from "@/lib/vault-items";

export const dynamic = "force-dynamic";

/** The vault's entries — public parts only; secrets never leave the server (spec 32). */
export async function GET() {
  const rows = await prisma.vaultItem.findMany({ orderBy: [{ type: "asc" }, { name: "asc" }] });
  return NextResponse.json(rows.map(toPublicItem));
}

export async function POST(req: NextRequest) {
  const parsed = vaultCreateSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid entry" }, { status: 400 });
  }
  const built = itemFromInput(parsed.data);
  if (!built.ok) return NextResponse.json({ error: built.error }, { status: 400 });
  const { websites, botIds, secret, ...rest } = built.row;
  try {
    const row = await prisma.vaultItem.create({
      data: {
        ...rest,
        websites: (websites as Prisma.InputJsonValue | null) ?? Prisma.DbNull,
        botIds: (botIds as Prisma.InputJsonValue | null) ?? Prisma.DbNull,
        secret: secret as Prisma.InputJsonValue,
      },
    });
    return NextResponse.json(toPublicItem(row), { status: 201 });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      return NextResponse.json({ error: `There is already a ${built.row.type} named “${built.row.name}”` }, { status: 409 });
    }
    throw err;
  }
}
