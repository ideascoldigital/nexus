import { prisma } from "@nexux/db";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ projectId: string }> };

/** A project's simple to-dos (spec 39, the project chat's Details): open first, in order, then done. */
export async function GET(_req: NextRequest, { params }: Params) {
  const { projectId } = await params;
  const todos = await prisma.projectTodo.findMany({
    where: { projectId },
    orderBy: [{ done: "asc" }, { position: "asc" }, { createdAt: "asc" }],
  });
  return NextResponse.json(todos);
}

const createSchema = z.object({ title: z.string().trim().min(1).max(500) });

export async function POST(req: NextRequest, { params }: Params) {
  const { projectId } = await params;
  const parsed = createSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "A to-do needs a title" }, { status: 400 });
  const project = await prisma.project.findUnique({ where: { id: projectId }, select: { id: true } });
  if (!project) return NextResponse.json({ error: "Project not found" }, { status: 404 });
  const last = await prisma.projectTodo.aggregate({ where: { projectId }, _max: { position: true } });
  const todo = await prisma.projectTodo.create({
    data: { projectId, title: parsed.data.title, position: (last._max.position ?? -1) + 1 },
  });
  return NextResponse.json(todo, { status: 201 });
}
