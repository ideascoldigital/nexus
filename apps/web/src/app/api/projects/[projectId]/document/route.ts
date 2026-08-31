import { NextResponse } from 'next/server';
import { prisma } from "@nexux/db";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ projectId: string }> }
) {
  const { projectId } = await params;
  const document = await prisma.projectDocument.findUnique({
    where: { projectId },
    include: { sections: { orderBy: [{ phaseKey: 'asc' }, { order: 'asc' }] } },
  });
  if (!document) {
    return NextResponse.json({ error: 'Document not initialized' }, { status: 404 });
  }
  return NextResponse.json(document);
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ projectId: string }> }
) {
  const { projectId } = await params;
  const body = await request.json();
  const { sectionId, content, status } = body ?? {};

  if (!sectionId || typeof content !== 'string') {
    return NextResponse.json(
      { error: 'sectionId and content required' },
      { status: 400 }
    );
  }

  const section = await prisma.projectDocumentSection.findUnique({
    where: { id: sectionId },
    include: { document: true },
  });
  if (!section || section.document.projectId !== projectId) {
    return NextResponse.json({ error: 'Section not found' }, { status: 404 });
  }

  const updated = await prisma.projectDocumentSection.update({
    where: { id: sectionId },
    data: {
      content,
      status: status ?? section.status,
    },
  });

  await prisma.projectDocumentRevision.create({
    data: {
      sectionId,
      content,
      authorRole: 'user',
    },
  });

  return NextResponse.json(updated);
}
