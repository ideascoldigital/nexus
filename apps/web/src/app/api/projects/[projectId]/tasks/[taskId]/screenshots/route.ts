import fs from "fs";
import { prisma } from "@nexux/db";
import { NextRequest, NextResponse } from "next/server";
import { taskScreenshotDir } from "@/lib/task-manager";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ projectId: string; taskId: string }> };

// Names of the screenshots collected for a task (stored outside the repo).
export async function GET(_req: NextRequest, { params }: Params) {
  const { projectId, taskId } = await params;

  const task = await prisma.sandboxTask.findFirst({
    where: { id: taskId, sandbox: { projectId } },
    select: { id: true },
  });
  if (!task) {
    return NextResponse.json({ error: "Task not found" }, { status: 404 });
  }

  const dir = taskScreenshotDir(taskId);
  if (!fs.existsSync(dir)) return NextResponse.json({ files: [] });

  const files = fs
    .readdirSync(dir)
    .filter((f) => /\.(png|jpe?g|gif|webp)$/i.test(f))
    .sort();

  return NextResponse.json({ files });
}
