import { prisma } from "@nexux/db";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

const createConversationSchema = z.object({
  name: z.string().optional(),
  featureId: z.string().optional(),
  agentId: z.string().optional(),
  model: z.string().default("opus"),
  permissionMode: z.string().default("acceptEdits"),
  systemPrompt: z.string().optional(),
  prompt: z.string().min(1, "Prompt is required"),
});

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ projectId: string }> }
) {
  const { projectId } = await params;

  const conversations = await prisma.conversation.findMany({
    where: { projectId },
    orderBy: { lastActivity: "desc" },
    include: {
      agent: { select: { id: true, name: true, color: true } },
      feature: { select: { id: true, title: true } },
      _count: { select: { messages: true } },
    },
  });

  return NextResponse.json(conversations);
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ projectId: string }> }
) {
  const { projectId } = await params;

  const body = await req.json();
  const parsed = createConversationSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const project = await prisma.project.findUnique({
    where: { id: projectId },
  });
  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  const sessionId = crypto.randomUUID();
  const { prompt, ...rest } = parsed.data;

  const conversation = await prisma.conversation.create({
    data: {
      ...rest,
      projectId,
      sessionId,
      status: "idle",
    },
  });

  // The frontend will call the sidecar to start the process
  return NextResponse.json({ ...conversation, prompt }, { status: 201 });
}
