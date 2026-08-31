import { prisma } from "@nexux/db";
import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ projectId: string; taskId: string }> };

// GET — full task including the streamed log
export async function GET(_req: NextRequest, { params }: Params) {
  const { projectId, taskId } = await params;

  const task = await prisma.sandboxTask.findFirst({
    where: { id: taskId, sandbox: { projectId } },
    include: {
      sandbox: { select: { name: true, publicIp: true } },
      feature: { select: { title: true } },
    },
  });
  if (!task) {
    return NextResponse.json({ error: "Task not found" }, { status: 404 });
  }

  return NextResponse.json(task);
}

// DELETE — remove a finished task from the history
export async function DELETE(_req: NextRequest, { params }: Params) {
  const { projectId, taskId } = await params;

  const task = await prisma.sandboxTask.findFirst({
    where: { id: taskId, sandbox: { projectId } },
  });
  if (!task) {
    return NextResponse.json({ error: "Task not found" }, { status: 404 });
  }
  if (task.status === "running" || task.status === "queued") {
    return NextResponse.json(
      { error: "Task is still running" },
      { status: 400 },
    );
  }

  await prisma.sandboxTask.delete({ where: { id: taskId } });
  return NextResponse.json({ success: true });
}
