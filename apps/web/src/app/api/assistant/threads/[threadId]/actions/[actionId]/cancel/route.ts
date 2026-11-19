import { NextRequest, NextResponse } from "next/server";

import { AssistantError, cancelAction } from "@/lib/assistant/threads";

export const dynamic = "force-dynamic";
export const maxDuration = 600;

type Params = { params: Promise<{ threadId: string; actionId: string }> };

/** The user's decision on a write the assistant asked for (spec 30). */
export async function POST(_req: NextRequest, { params }: Params) {
  const { threadId, actionId } = await params;
  try {
    return NextResponse.json(await cancelAction(threadId, actionId));
  } catch (err) {
    if (err instanceof AssistantError) return NextResponse.json({ error: err.message }, { status: err.status });
    throw err;
  }
}
