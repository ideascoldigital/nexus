import { prisma } from "@nexux/db";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

const updateAgentSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().nullable().optional(),
  systemPrompt: z.string().min(1).optional(),
  model: z.string().optional(),
  color: z.string().optional(),
});

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ agentId: string }> },
) {
  const { agentId } = await params;
  const agent = await prisma.agent.findUnique({
    where: { id: agentId },
    include: { _count: { select: { conversations: true } } },
  });
  if (!agent) {
    return NextResponse.json({ error: "Agent not found" }, { status: 404 });
  }
  return NextResponse.json(agent);
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ agentId: string }> },
) {
  const { agentId } = await params;
  const existing = await prisma.agent.findUnique({ where: { id: agentId } });
  if (!existing) {
    return NextResponse.json({ error: "Agent not found" }, { status: 404 });
  }
  if (existing.isBuiltIn) {
    return NextResponse.json(
      { error: "Built-in agents cannot be edited" },
      { status: 403 },
    );
  }

  const body = await req.json();
  const parsed = updateAgentSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  if (parsed.data.name && parsed.data.name !== existing.name) {
    const conflict = await prisma.agent.findUnique({
      where: { name: parsed.data.name },
    });
    if (conflict) {
      return NextResponse.json(
        { error: "Agent with this name already exists" },
        { status: 409 },
      );
    }
  }

  const updated = await prisma.agent.update({
    where: { id: agentId },
    data: parsed.data,
  });
  return NextResponse.json(updated);
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ agentId: string }> },
) {
  const { agentId } = await params;
  const existing = await prisma.agent.findUnique({ where: { id: agentId } });
  if (!existing) {
    return NextResponse.json({ error: "Agent not found" }, { status: 404 });
  }
  if (existing.isBuiltIn) {
    return NextResponse.json(
      { error: "Built-in agents cannot be deleted" },
      { status: 403 },
    );
  }
  await prisma.agent.delete({ where: { id: agentId } });
  return NextResponse.json({ ok: true });
}
