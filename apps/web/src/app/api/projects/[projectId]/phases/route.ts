import { NextResponse } from 'next/server';
import { prisma } from "@nexux/db";

const ALLOWED_STATUS = ['locked', 'active', 'completed', 'revisiting'] as const;

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ projectId: string }> }
) {
  const { projectId } = await params;
  const phases = await prisma.phase.findMany({
    where: { projectId },
    orderBy: { order: 'asc' },
  });
  return NextResponse.json(phases);
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ projectId: string }> }
) {
  const { projectId } = await params;
  const body = await request.json();
  const { phaseKey, status } = body ?? {};

  if (!phaseKey || typeof phaseKey !== 'string') {
    return NextResponse.json({ error: 'phaseKey required' }, { status: 400 });
  }
  if (!ALLOWED_STATUS.includes(status)) {
    return NextResponse.json({ error: 'Invalid status' }, { status: 400 });
  }

  const target = await prisma.phase.findUnique({
    where: { projectId_key: { projectId, key: phaseKey } },
  });
  if (!target) {
    return NextResponse.json({ error: 'Phase not found' }, { status: 404 });
  }

  // Invariant: at most one phase active at any time.
  if (status === 'active') {
    await prisma.phase.updateMany({
      where: { projectId, status: 'active', NOT: { key: phaseKey } },
      data: { status: 'completed' },
    });
  }

  const updated = await prisma.phase.update({
    where: { projectId_key: { projectId, key: phaseKey } },
    data: { status },
  });

  return NextResponse.json(updated);
}
