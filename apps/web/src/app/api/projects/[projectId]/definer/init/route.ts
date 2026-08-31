import { NextResponse } from 'next/server';
import { initDefinerForProject } from '@/services/project-definer-agents';
import { prisma } from "@nexux/db";

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ projectId: string }> }
) {
  const { projectId } = await params;

  const project = await prisma.project.findUnique({ where: { id: projectId } });
  if (!project) {
    return NextResponse.json({ error: 'Project not found' }, { status: 404 });
  }

  const result = await initDefinerForProject(projectId);
  return NextResponse.json(result);
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ projectId: string }> }
) {
  const { projectId } = await params;
  const document = await prisma.projectDocument.findUnique({
    where: { projectId },
    include: { sections: { orderBy: { order: 'asc' } } },
  });
  const phases = await prisma.phase.findMany({
    where: { projectId },
    orderBy: { order: 'asc' },
  });
  const conversation = document?.conversationId
    ? await prisma.conversation.findUnique({
        where: { id: document.conversationId },
        include: { messages: { orderBy: { createdAt: 'asc' } } },
      })
    : null;

  return NextResponse.json({
    initialized: Boolean(document),
    document,
    phases,
    conversation,
  });
}
