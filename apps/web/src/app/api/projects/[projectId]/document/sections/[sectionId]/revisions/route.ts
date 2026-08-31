import { NextResponse } from 'next/server';
import { prisma } from "@nexux/db";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ projectId: string; sectionId: string }> }
) {
  const { projectId, sectionId } = await params;
  const section = await prisma.projectDocumentSection.findUnique({
    where: { id: sectionId },
    include: { document: true },
  });
  if (!section || section.document.projectId !== projectId) {
    return NextResponse.json({ error: 'Section not found' }, { status: 404 });
  }
  const revisions = await prisma.projectDocumentRevision.findMany({
    where: { sectionId },
    orderBy: { createdAt: 'desc' },
  });
  return NextResponse.json(revisions);
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ projectId: string; sectionId: string }> }
) {
  const { projectId, sectionId } = await params;
  const body = await request.json();
  const { revisionId } = body ?? {};
  if (!revisionId) {
    return NextResponse.json({ error: 'revisionId required' }, { status: 400 });
  }

  const revision = await prisma.projectDocumentRevision.findUnique({
    where: { id: revisionId },
    include: { section: { include: { document: true } } },
  });
  if (
    !revision ||
    revision.sectionId !== sectionId ||
    revision.section.document.projectId !== projectId
  ) {
    return NextResponse.json({ error: 'Revision not found' }, { status: 404 });
  }

  await prisma.projectDocumentSection.update({
    where: { id: sectionId },
    data: { content: revision.content },
  });

  const newRevision = await prisma.projectDocumentRevision.create({
    data: {
      sectionId,
      content: revision.content,
      authorRole: `restore:${revision.authorRole}`,
    },
  });

  return NextResponse.json(newRevision);
}
