import { prisma } from "@nexux/db";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getActiveWorkspaceId } from "@/lib/workspace";

const createAgentSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  systemPrompt: z.string().min(1),
  model: z.string().default("opus"),
  color: z.string().default("#3b82f6"),
});

export async function GET() {
  const workspaceId = await getActiveWorkspaceId();
  // Own catalog + inherited default-workspace agents — own wins on a clash.
  const rows = await prisma.agent.findMany({
    where: { workspaceId: { in: [workspaceId, "ws-default"] } },
    orderBy: [{ isBuiltIn: "desc" }, { name: "asc" }],
    include: { _count: { select: { conversations: true } } },
  });
  const byName = new Map<string, (typeof rows)[number]>();
  for (const row of rows) {
    const existing = byName.get(row.name);
    if (!existing || row.workspaceId === workspaceId) byName.set(row.name, row);
  }
  return NextResponse.json(
    [...byName.values()].map((row) => ({
      ...row,
      inherited: row.workspaceId !== workspaceId,
    })),
  );
}

export async function POST(req: NextRequest) {
  const body = await req.json();
  const parsed = createAgentSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const existing = await prisma.agent.findUnique({
    where: { name: parsed.data.name },
  });
  if (existing) {
    return NextResponse.json(
      { error: "Agent with this name already exists" },
      { status: 409 }
    );
  }

  const agent = await prisma.agent.create({
    data: { ...parsed.data, workspaceId: await getActiveWorkspaceId() },
  });
  return NextResponse.json(agent, { status: 201 });
}
