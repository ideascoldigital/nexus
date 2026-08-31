import { prisma } from "@nexux/db";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  enqueueDevPrompt,
  stageDevAttachments,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENT_COUNT,
} from "@/lib/dev-console";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ projectId: string; sandboxId: string }> };

/** Dev-console feed: this sandbox's dev prompts, oldest first (chat order). */
export async function GET(_req: NextRequest, { params }: Params) {
  const { projectId, sandboxId } = await params;

  const sandbox = await prisma.sandbox.findFirst({
    where: { id: sandboxId, projectId },
    select: {
      id: true,
      dedicated: true,
      muteTelegram: true,
      muteSlack: true,
      devSessionId: true,
    },
  });
  if (!sandbox) {
    return NextResponse.json({ error: "Sandbox not found" }, { status: 404 });
  }

  const tasks = await prisma.sandboxTask.findMany({
    where: { sandboxId, kind: "dev" },
    orderBy: { createdAt: "asc" },
    take: 100,
    select: {
      id: true,
      prompt: true,
      status: true,
      phase: true,
      result: true,
      error: true,
      prUrl: true,
      costUsd: true,
      durationMs: true,
      createdAt: true,
      finishedAt: true,
      log: true,
      attachments: true,
    },
  });

  // Ship the log only while a prompt runs (live tail); finished ones keep
  // the payload light — their outcome is the result text. Attachment host
  // paths stay server-side; the UI gets name/mime/size chips only.
  const shaped = tasks.map(({ log, attachments, ...t }) => ({
    ...t,
    attachments: Array.isArray(attachments)
      ? (attachments as Array<{ name: string; mime: string; size: number }>).map(
          (a) => ({ name: a.name, mime: a.mime, size: a.size }),
        )
      : [],
    logTail:
      t.status === "running"
        ? log.split("\n").filter(Boolean).slice(-12).join("\n")
        : null,
  }));

  return NextResponse.json({
    tasks: shaped,
    muteTelegram: sandbox.muteTelegram,
    muteSlack: sandbox.muteSlack,
    hasSession: Boolean(sandbox.devSessionId),
  });
}

const promptSchema = z.string().trim().min(1).max(20_000);
const postSchema = z.object({ prompt: promptSchema });

export async function POST(req: NextRequest, { params }: Params) {
  const { projectId, sandboxId } = await params;

  // JSON = plain prompt; multipart = prompt + attached files (images, docs…).
  let prompt: string;
  let files: Array<{ name: string; mime: string; data: Buffer }> = [];
  if (req.headers.get("content-type")?.includes("multipart/form-data")) {
    const form = await req.formData().catch(() => null);
    const parsed = promptSchema.safeParse(form?.get("prompt"));
    if (!form || !parsed.success) {
      return NextResponse.json({ error: "Prompt is required" }, { status: 400 });
    }
    prompt = parsed.data;
    const entries = form
      .getAll("files")
      .filter((f): f is File => f instanceof File && f.size > 0);
    if (entries.length > MAX_ATTACHMENT_COUNT) {
      return NextResponse.json(
        { error: `Too many attachments (max ${MAX_ATTACHMENT_COUNT})` },
        { status: 400 },
      );
    }
    if (entries.reduce((n, f) => n + f.size, 0) > MAX_ATTACHMENT_BYTES) {
      return NextResponse.json(
        {
          error: `Attachments too large (max ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB per prompt)`,
        },
        { status: 400 },
      );
    }
    files = await Promise.all(
      entries.map(async (f) => ({
        name: f.name,
        mime: f.type,
        data: Buffer.from(await f.arrayBuffer()),
      })),
    );
  } else {
    const parsed = postSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json({ error: "Prompt is required" }, { status: 400 });
    }
    prompt = parsed.data.prompt;
  }

  try {
    const attachments = await stageDevAttachments(files);
    const task = await enqueueDevPrompt(projectId, sandboxId, prompt, {
      attachments,
    });
    return NextResponse.json(task, { status: 201 });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Could not queue prompt";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
