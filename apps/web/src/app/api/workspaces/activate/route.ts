import { prisma } from "@nexux/db";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { WORKSPACE_COOKIE } from "@/lib/workspace";

export const dynamic = "force-dynamic";

const schema = z.object({ id: z.string().min(1) });

/** Switch the active workspace — sets the cookie the whole app reads. */
export async function POST(req: NextRequest) {
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }
  const ws = await prisma.workspace.findUnique({
    where: { id: parsed.data.id },
    select: { id: true },
  });
  if (!ws) {
    return NextResponse.json({ error: "Workspace not found" }, { status: 404 });
  }
  const res = NextResponse.json({ activeId: ws.id });
  res.cookies.set(WORKSPACE_COOKIE, ws.id, {
    path: "/",
    sameSite: "lax",
    maxAge: 60 * 60 * 24 * 365,
  });
  return res;
}
