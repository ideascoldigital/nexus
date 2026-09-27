/**
 * One user message to a thread (spec 30). Blocking in phase 1 — the whole
 * loop runs before the response; streaming comes with phase 3. Reads run;
 * a write comes back as a pending action in the thread.
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

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
  try {
    return NextResponse.json(await runThreadTurn(threadId, parsed.data.message, { context: parsed.data.context }));
  } catch (err) {
    if (err instanceof AssistantError) return NextResponse.json({ error: err.message }, { status: err.status });
    throw err;
  }
}
