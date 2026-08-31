import { prisma } from "@nexux/db";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

type Params = { params: Promise<{ projectId: string; conversationId: string }> };

// Every field is optional (partial update), but each one is pinned: the body
// used to spread into prisma.update, and lastActivity went through `new Date`
// without a check, so an unparseable value produced an Invalid Date.
const putSchema = z.object({
  name: z.string().nullable().optional(),
  status: z.enum(["idle", "running", "paused", "completed", "error"]).optional(),
  totalCostUsd: z.number().nonnegative().optional(),
  lastActivity: z.coerce.date().optional(),
});

export async function GET(_req: NextRequest, { params }: Params) {
  const { conversationId } = await params;

  const conversation = await prisma.conversation.findUnique({
    where: { id: conversationId },
    include: {
      agent: { select: { id: true, name: true, color: true } },
      feature: { select: { id: true, title: true } },
      messages: { orderBy: { createdAt: "asc" } },
      project: {
        select: {
          id: true,
          name: true,
          repositories: { where: { isMain: true }, take: 1 },
        },
      },
    },
  });

  if (!conversation) {
    return NextResponse.json(
      { error: "Conversation not found" },
      { status: 404 }
    );
  }

  return NextResponse.json(conversation);
}

export async function PUT(req: NextRequest, { params }: Params) {
  const { conversationId } = await params;
  const parsed = putSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.flatten() },
      { status: 400 }
    );
  }
  const { name, status, totalCostUsd, lastActivity } = parsed.data;

  const existing = await prisma.conversation.findUnique({
    where: { id: conversationId },
    select: { id: true },
  });
  if (!existing) {
    return NextResponse.json(
      { error: "Conversation not found" },
      { status: 404 }
    );
  }

  const conversation = await prisma.conversation.update({
    where: { id: conversationId },
    data: {
      ...(name !== undefined && { name }),
      ...(status !== undefined && { status }),
      ...(totalCostUsd !== undefined && { totalCostUsd }),
      ...(lastActivity !== undefined && { lastActivity }),
    },
  });

  return NextResponse.json(conversation);
}

export async function DELETE(_req: NextRequest, { params }: Params) {
  const { conversationId } = await params;

  await prisma.conversation.delete({ where: { id: conversationId } });
  return NextResponse.json({ success: true });
}
