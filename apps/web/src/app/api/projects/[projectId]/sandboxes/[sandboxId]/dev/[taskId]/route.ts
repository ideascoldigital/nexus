import { prisma } from "@nexux/db";
import { NextRequest, NextResponse } from "next/server";
import { cancelDevPrompt, stopDevTask } from "@/lib/dev-console";

export const dynamic = "force-dynamic";

type Params = {
  params: Promise<{ projectId: string; sandboxId: string; taskId: string }>;
};

/** Cancel a queued dev prompt, or stop one that is already running. */
export async function DELETE(_req: NextRequest, { params }: Params) {
  const { projectId, sandboxId, taskId } = await params;

  const task = await prisma.sandboxTask.findFirst({
    where: { id: taskId, sandboxId, kind: "dev", sandbox: { projectId } },
  });
  if (!task) {
    return NextResponse.json({ error: "Prompt not found" }, { status: 404 });
  }

  const canceled =
    task.status === "running"
      ? await stopDevTask(taskId)
      : await cancelDevPrompt(taskId);
  if (!canceled) {
    return NextResponse.json(
      { error: "Prompt already finished — nothing to cancel" },
      { status: 409 },
    );
  }
  return NextResponse.json({ canceled: true });
}
