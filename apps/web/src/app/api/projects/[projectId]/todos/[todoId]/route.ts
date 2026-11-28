import { prisma } from "@nexux/db";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { parsePrLink } from "@/lib/pr-link";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ projectId: string; todoId: string }> };

const patchSchema = z.object({
  title: z.string().trim().min(1).max(500).optional(),
  done: z.boolean().optional(),
  prUrl: z.string().trim().max(1000).nullable().optional(),
});

/** Rename, tick off or link the pull request of one to-do. */
export async function PATCH(req: NextRequest, { params }: Params) {
  const { projectId, todoId } = await params;
  const parsed = patchSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Bad to-do update" }, { status: 400 });
  const { title, done, prUrl } = parsed.data;
  const data: { title?: string; done?: boolean; doneAt?: Date | null; prUrl?: string | null } = {};
  if (title !== undefined) data.title = title;
  if (done !== undefined) {
    data.done = done;
    data.doneAt = done ? new Date() : null;
  }
  if (prUrl !== undefined) {
    if (prUrl) {
      const pr = parsePrLink(prUrl);
      if (!pr) return NextResponse.json({ error: "That is not a link" }, { status: 400 });
      data.prUrl = pr.url;
    } else data.prUrl = null;
  }
  const { count } = await prisma.projectTodo.updateMany({ where: { id: todoId, projectId }, data });
  if (!count) return NextResponse.json({ error: "To-do not found" }, { status: 404 });
  return NextResponse.json(await prisma.projectTodo.findUnique({ where: { id: todoId } }));
}

export async function DELETE(_req: NextRequest, { params }: Params) {
  const { projectId, todoId } = await params;
  const { count } = await prisma.projectTodo.deleteMany({ where: { id: todoId, projectId } });
  if (!count) return NextResponse.json({ error: "To-do not found" }, { status: 404 });
  return NextResponse.json({ ok: true });
}
