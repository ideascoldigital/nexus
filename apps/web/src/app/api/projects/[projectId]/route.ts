import fs from "fs/promises";
import { prisma } from "@nexux/db";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { seedsRoot } from "@/lib/seed/store";

const updateProjectSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().optional().nullable(),
  workspaceId: z.string().min(1).optional(),
});

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ projectId: string }> }
) {
  const { projectId } = await params;

  const project = await prisma.project.findUnique({
    where: { id: projectId },
    include: {
      repositories: { orderBy: { isMain: "desc" } },
      _count: {
        select: {
          features: true,
          conversations: true,
          repositories: true,
        },
      },
    },
  });

  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  return NextResponse.json(project);
}

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ projectId: string }> }
) {
  const { projectId } = await params;
  const body = await req.json();
  const parsed = updateProjectSchema.safeParse(body);

  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.flatten() },
      { status: 400 }
    );
  }

  if (parsed.data.workspaceId) {
    const ws = await prisma.workspace.findUnique({
      where: { id: parsed.data.workspaceId },
      select: { id: true },
    });
    if (!ws) {
      return NextResponse.json(
        { error: "Workspace not found" },
        { status: 400 },
      );
    }
  }

  const project = await prisma.project.update({
    where: { id: projectId },
    data: parsed.data,
    include: { repositories: true },
  });

  return NextResponse.json(project);
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ projectId: string }> }
) {
  const { projectId } = await params;

  await prisma.project.delete({ where: { id: projectId } });
  // Seed files (spec 29) live on disk, not in a row the cascade can reach.
  await fs.rm(seedsRoot(projectId), { recursive: true, force: true }).catch(() => undefined);
  return NextResponse.json({ success: true });
}
