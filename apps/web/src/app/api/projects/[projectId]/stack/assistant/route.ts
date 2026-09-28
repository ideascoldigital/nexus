import { prisma } from "@nexux/db";
import { NextRequest, NextResponse } from "next/server";

import { stackThreadFor } from "@/lib/assistant/threads";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ projectId: string }> };

/**
 * The Stack tab's assistant: the project's "stack" thread of the global
 * assistant (spec 30), created on first use with the earlier Stack
 * conversation carried over. Turns go through /api/assistant/threads.
 */
export async function GET(_req: NextRequest, { params }: Params) {
  const { projectId } = await params;

  const project = await prisma.project.findUnique({ where: { id: projectId } });
  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  const [thread, indexCount] = await Promise.all([
    stackThreadFor(projectId),
    prisma.embeddingIndex.count({ where: { projectId } }),
  ]);

  return NextResponse.json({
    threadId: thread.id,
    indexStatus: { indexed: indexCount > 0, count: indexCount },
  });
}
