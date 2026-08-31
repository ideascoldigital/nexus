import { prisma } from "@nexux/db";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getActiveWorkspaceId } from "@/lib/workspace";

export const dynamic = "force-dynamic";

export async function GET() {
  const [workspaces, activeId] = await Promise.all([
    prisma.workspace.findMany({
      orderBy: { createdAt: "asc" },
      include: { _count: { select: { projects: true } } },
    }),
    getActiveWorkspaceId(),
  ]);
  return NextResponse.json({
    activeId,
    workspaces: workspaces.map((w) => ({
      id: w.id,
      name: w.name,
      icon: w.icon,
      logo: w.logo,
      projectCount: w._count.projects,
    })),
  });
}

const createSchema = z.object({
  name: z.string().trim().min(1).max(60),
  icon: z.string().trim().max(8).optional(),
  logo: z.string().startsWith("data:image/").max(200_000).optional(),
});

export async function POST(req: NextRequest) {
  const parsed = createSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Name is required" }, { status: 400 });
  }
  const workspace = await prisma.workspace.create({
    data: {
      name: parsed.data.name,
      icon: parsed.data.icon || null,
      logo: parsed.data.logo || null,
    },
  });
  return NextResponse.json(workspace, { status: 201 });
}
