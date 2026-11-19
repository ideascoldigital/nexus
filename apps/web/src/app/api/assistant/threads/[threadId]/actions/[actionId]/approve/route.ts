import { NextRequest, NextResponse } from "next/server";

import { sseResponse, wantsStream } from "@/lib/assistant/sse";
import { AssistantError, approveAction, defaultAssistantDeps } from "@/lib/assistant/threads";

export const dynamic = "force-dynamic";
export const maxDuration = 600;

type Params = { params: Promise<{ threadId: string; actionId: string }> };

/** The user's decision on a write the assistant asked for (spec 30). */
export async function POST(req: NextRequest, { params }: Params) {
  const { threadId, actionId } = await params;
  if (wantsStream(req)) {
    return sseResponse((emit) => approveAction(threadId, actionId, defaultAssistantDeps(), emit));
  }
  try {
    return NextResponse.json(await approveAction(threadId, actionId));
  } catch (err) {
    if (err instanceof AssistantError) return NextResponse.json({ error: err.message }, { status: err.status });
    throw err;
  }
}
