import { prisma } from "@nexux/db";
import { NextRequest, NextResponse } from "next/server";

import { MAX_ATTACHMENT_BYTES } from "@/lib/bot-attachments";
import { saveUpload } from "@/lib/bot-uploads";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ botId: string }> };

/**
 * A file the user attaches to a message (multipart, field "file"). Stored in
 * Nexus; the message then links to it, and the file is copied into the bot's
 * computer when that message runs.
 */
export async function POST(req: NextRequest, { params }: Params) {
  const { botId } = await params;
  const bot = await prisma.bot.findUnique({ where: { id: botId }, select: { id: true } });
  if (!bot) return NextResponse.json({ error: "Bot not found" }, { status: 404 });
  const form = await req.formData().catch(() => null);
  const file = form?.get("file");
  if (!file || typeof file === "string") {
    return NextResponse.json({ error: "file is required" }, { status: 400 });
  }
  if (file.size === 0) return NextResponse.json({ error: "The file is empty" }, { status: 400 });
  if (file.size > MAX_ATTACHMENT_BYTES) {
    return NextResponse.json({ error: "Files can be up to 25 MB" }, { status: 413 });
  }
  const saved = saveUpload(botId, file.name || "file", Buffer.from(await file.arrayBuffer()));
  return NextResponse.json({ ...saved, size: file.size }, { status: 201 });
}
