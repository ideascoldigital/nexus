import fs from "fs";
import path from "path";
import { prisma } from "@nexux/db";
import { NextRequest, NextResponse } from "next/server";
import { taskScreenshotDir } from "@/lib/task-manager";

export const dynamic = "force-dynamic";

type Params = {
  params: Promise<{ projectId: string; taskId: string; name: string }>;
};

const CONTENT_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

// Serves one screenshot image. The filename is agent-provided, so it is
// resolved and confined to the task's own directory (no traversal).
export async function GET(_req: NextRequest, { params }: Params) {
  const { projectId, taskId, name } = await params;

  const task = await prisma.sandboxTask.findFirst({
    where: { id: taskId, sandbox: { projectId } },
    select: { id: true },
  });
  if (!task) {
    return NextResponse.json({ error: "Task not found" }, { status: 404 });
  }

  const dir = taskScreenshotDir(taskId);
  const filePath = path.resolve(dir, name);
  if (path.dirname(filePath) !== path.resolve(dir)) {
    return NextResponse.json({ error: "Invalid name" }, { status: 400 });
  }

  const ext = path.extname(filePath).toLowerCase();
  const contentType = CONTENT_TYPES[ext];
  if (!contentType || !fs.existsSync(filePath)) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const body = new Uint8Array(fs.readFileSync(filePath));
  return new NextResponse(body, {
    headers: {
      "Content-Type": contentType,
      "Cache-Control": "private, max-age=3600",
    },
  });
}
