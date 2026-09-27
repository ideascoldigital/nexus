/**
 * One user message to a thread (spec 30). With `Accept: text/event-stream`
 * each step is streamed as it is stored; otherwise the whole thread comes
 * back at the end. Reads run; a write comes back as a pending action.
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { sseResponse, wantsStream } from "@/lib/assistant/sse";
import { AssistantError, runThreadTurn } from "@/lib/assistant/threads";

export const dynamic = "force-dynamic";
export const maxDuration = 600;

type Params = { params: Promise<{ threadId: string }> };

const bodySchema = z.object({
  message: z.string().trim().min(1).max(20_000),
  /** The page the message was sent from. */
  context: z.object({ projectId: z.string().min(1).nullable().optional() }).optional(),
});

export async function POST(req: NextRequest, { params }: Params) {
  const { threadId } = await params;
  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  if (wantsStream(req)) {
    return sseResponse((emit) => runThreadTurn(threadId, parsed.data.message, { context: parsed.data.context, emit }));
  }
  try {
    return NextResponse.json(await runThreadTurn(threadId, parsed.data.message, { context: parsed.data.context }));
  } catch (err) {
    if (err instanceof AssistantError) return NextResponse.json({ error: err.message }, { status: err.status });
    throw err;
  }
}
