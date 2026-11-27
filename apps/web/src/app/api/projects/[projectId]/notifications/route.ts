import { prisma } from "@nexux/db";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

type Params = { params: Promise<{ projectId: string }> };

/**
 * Where a project's notifications go (spec 39, the project chat's Details):
 * a Telegram chat and a Slack channel. Its own route because the sandbox setup
 * PUT replaces the whole config — saving two fields through it would reset the
 * rest to defaults.
 */
const patchSchema = z.object({
  telegramChatId: z.string().trim().max(100).nullable().optional(),
  slackChannelId: z.string().trim().max(100).nullable().optional(),
});

export async function GET(_req: NextRequest, { params }: Params) {
  const { projectId } = await params;
  const config = await prisma.sandboxConfig.findUnique({
    where: { projectId },
    select: { telegramChatId: true, slackChannelId: true },
  });
  return NextResponse.json({ telegramChatId: config?.telegramChatId ?? null, slackChannelId: config?.slackChannelId ?? null });
}

export async function PATCH(req: NextRequest, { params }: Params) {
  const { projectId } = await params;
  const parsed = patchSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  const project = await prisma.project.findUnique({ where: { id: projectId }, select: { id: true } });
  if (!project) return NextResponse.json({ error: "Project not found" }, { status: 404 });
  const data: { telegramChatId?: string | null; slackChannelId?: string | null } = {};
  if (parsed.data.telegramChatId !== undefined) data.telegramChatId = parsed.data.telegramChatId || null;
  if (parsed.data.slackChannelId !== undefined) data.slackChannelId = parsed.data.slackChannelId || null;
  const saved = await prisma.sandboxConfig.upsert({
    where: { projectId },
    create: { projectId, ...data },
    update: data,
    select: { telegramChatId: true, slackChannelId: true },
  });
  return NextResponse.json(saved);
}
