import { prisma } from "@nexux/db";
import { NextRequest, NextResponse } from "next/server";

import { initStackAssistant } from "@/services/stack-assistant-agent";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ projectId: string }> };

export async function GET(_req: NextRequest, { params }: Params) {
  const { projectId } = await params;

  const project = await prisma.project.findUnique({ where: { id: projectId } });
  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  const [conversation, indexCount] = await Promise.all([
    initStackAssistant(projectId),
    prisma.embeddingIndex.count({ where: { projectId } }),
  ]);

  return NextResponse.json({
    conversationId: conversation.id,
    messages: conversation.messages.map((m) => ({
      id: m.id,
      role: m.role,
      agentRole: m.agentRole,
      content: m.content,
      createdAt: m.createdAt,
    })),
    indexStatus: { indexed: indexCount > 0, count: indexCount },
  });
}
