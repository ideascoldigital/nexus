import { prisma } from "@nexux/db";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { DEFAULT_WORKSPACE_ID } from "@/lib/workspace";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ workspaceId: string }> };

const patchSchema = z.object({
  name: z.string().trim().min(1).max(60).optional(),
  icon: z.string().trim().max(8).nullable().optional(),
  logo: z.string().startsWith("data:image/").max(200_000).nullable().optional(),
});

export async function PATCH(req: NextRequest, { params }: Params) {
  const { workspaceId } = await params;
  const parsed = patchSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }
  const ws = await prisma.workspace.findUnique({ where: { id: workspaceId } });
  if (!ws) {
    return NextResponse.json({ error: "Workspace not found" }, { status: 404 });
  }
  const updated = await prisma.workspace.update({
    where: { id: workspaceId },
    data: {
      ...(parsed.data.name ? { name: parsed.data.name } : {}),
      ...(parsed.data.icon !== undefined ? { icon: parsed.data.icon || null } : {}),
      ...(parsed.data.logo !== undefined ? { logo: parsed.data.logo } : {}),
    },
  });
  return NextResponse.json(updated);
}

/** Delete a workspace — only when empty, never the default. */
export async function DELETE(_req: NextRequest, { params }: Params) {
  const { workspaceId } = await params;

  if (workspaceId === DEFAULT_WORKSPACE_ID) {
    return NextResponse.json(
      { error: "The default workspace cannot be deleted" },
      { status: 400 },
    );
  }
  const ws = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    include: { _count: { select: { projects: true, agents: true, skills: true, credentials: true } } },
  });
  if (!ws) {
    return NextResponse.json({ error: "Workspace not found" }, { status: 404 });
  }
  const c = ws._count;
  if (c.projects + c.agents + c.skills + c.credentials > 0) {
    return NextResponse.json(
      { error: "Workspace is not empty — move or delete its contents first" },
      { status: 409 },
    );
  }
  await prisma.workspace.delete({ where: { id: workspaceId } });
  // Its scoped settings rows (ws:<id>:*) become unreachable leftovers; sweep.
  await prisma.settings.deleteMany({
    where: { key: { startsWith: `ws:${workspaceId}:` } },
  });
  return NextResponse.json({ deleted: true });
}
