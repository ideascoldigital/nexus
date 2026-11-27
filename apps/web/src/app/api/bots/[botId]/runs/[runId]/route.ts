import { NextRequest, NextResponse } from "next/server";
import { cancelBotRun } from "@/lib/bot-manager";
import { runDraft } from "@/lib/run-drafts";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ botId: string; runId: string }> };

/** The reply the run is writing right now — polled by the chat while it runs; memory only, no DB. */
export async function GET(_req: NextRequest, { params }: Params) {
  const { runId } = await params;
  return NextResponse.json({ draft: runDraft(runId) });
}

/** Cancel a queued prompt, or stop the one that is running. */
export async function DELETE(_req: NextRequest, { params }: Params) {
  const { botId, runId } = await params;
  const ok = await cancelBotRun(botId, runId);
  if (!ok) {
    return NextResponse.json({ error: "Nothing to cancel" }, { status: 409 });
  }
  return NextResponse.json({ ok: true });
}
