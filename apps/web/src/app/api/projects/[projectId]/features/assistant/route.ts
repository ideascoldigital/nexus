import { prisma } from "@nexux/db";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import type { InlineMessage } from "@ideascol/agents-generator-sdk";
import { runFeatureAssistantTurn } from "@/services/feature-assistant";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ projectId: string }> };

// Pasting a written spec or plan into the assistant is a first-class use of
// this drawer, not an abuse of it — the old 8k ceiling rejected an ordinary
// design doc while allowing 30 history entries of 16k each, which is backwards.
// The cap exists to bound one request, not to keep the idea short.
const MAX_MESSAGE_CHARS = 32_000;
const MAX_HISTORY_ENTRIES = 30;
const MAX_HISTORY_CHARS = 16_000;

const bodySchema = z.object({
  message: z.string().trim().min(1).max(MAX_MESSAGE_CHARS),
  history: z
    .array(
      z.object({
        role: z.enum(["user", "assistant"]),
        content: z.string().max(MAX_HISTORY_CHARS),
      }),
    )
    .max(MAX_HISTORY_ENTRIES)
    .default([]),
});

/**
 * A 400 the user can act on. "Invalid body" sent people to read the route
 * source to discover they had hit a length cap, so say which limit and by how
 * much — the number is the whole point of the message.
 */
function describeBodyError(body: unknown): string {
  const message = (body as { message?: unknown } | null)?.message;
  if (typeof message === "string") {
    const length = message.trim().length;
    if (length === 0) return "The message is empty.";
    if (length > MAX_MESSAGE_CHARS) {
      return `The message is ${length.toLocaleString("en-US")} characters; the limit is ${MAX_MESSAGE_CHARS.toLocaleString("en-US")}. Trim it, or attach the long version to the feature and describe it here.`;
    }
  }
  const history = (body as { history?: unknown } | null)?.history;
  if (Array.isArray(history)) {
    if (history.length > MAX_HISTORY_ENTRIES) {
      return `This conversation has ${history.length} messages; the limit is ${MAX_HISTORY_ENTRIES}. Start a new one.`;
    }
    const long = history.find(
      (m) =>
        typeof (m as { content?: unknown })?.content === "string" &&
        (m as { content: string }).content.length > MAX_HISTORY_CHARS,
    );
    if (long) {
      return `An earlier message in this conversation exceeds ${MAX_HISTORY_CHARS.toLocaleString("en-US")} characters. Start a new one.`;
    }
  }
  return "Invalid body";
}

export async function POST(req: NextRequest, { params }: Params) {
  const { projectId } = await params;

  const body = await req.json().catch(() => null);
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: describeBodyError(body) },
      { status: 400 },
    );
  }

  const project = await prisma.project.findUnique({ where: { id: projectId } });
  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  try {
    const turn = await runFeatureAssistantTurn(
      projectId,
      parsed.data.message,
      parsed.data.history as InlineMessage[],
    );
    return NextResponse.json(turn);
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Assistant request failed";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
