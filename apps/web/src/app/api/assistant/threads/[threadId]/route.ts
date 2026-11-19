import { NextRequest, NextResponse } from "next/server";

import { AssistantError, deleteThread, getThread } from "@/lib/assistant/threads";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ threadId: string }> };

/** The transcript and the thread's actions, in order. */
export async function GET(_req: NextRequest, { params }: Params) {
  const { threadId } = await params;
  const thread = await getThread(threadId);
  if (!thread) return NextResponse.json({ error: "Thread not found" }, { status: 404 });
  return NextResponse.json(thread);
}

export async function DELETE(_req: NextRequest, { params }: Params) {
  const { threadId } = await params;
  try {
    await deleteThread(threadId);
    return new NextResponse(null, { status: 204 });
  } catch (err) {
    if (err instanceof AssistantError) return NextResponse.json({ error: err.message }, { status: err.status });
    throw err;
  }
}
