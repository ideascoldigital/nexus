import { NextRequest, NextResponse } from "next/server";

import { enqueueBotPrompt } from "@/lib/bot-manager";
import { approveConfirmation, dropConfirmation } from "@/lib/nexus-confirmations";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ botId: string; actionId: string }> };

/**
 * The user's answer to a confirm card in a project chat (spec 39): approve
 * lets the chat's next try go through; cancel drops it. Either way the chat
 * hears about it as the user's message.
 */
export async function POST(req: NextRequest, { params }: Params) {
  const { botId, actionId } = await params;
  const body = (await req.json().catch(() => ({}))) as { decision?: unknown };
  if (body.decision === "cancel") {
    dropConfirmation(botId, actionId);
    const run = await enqueueBotPrompt(botId, "No, cancel that — don't do it.");
    return NextResponse.json({ ok: true, runId: run.id });
  }
  if (body.decision !== "approve") {
    return NextResponse.json({ error: "decision must be approve or cancel" }, { status: 400 });
  }
  const approved = approveConfirmation(botId, actionId);
  if (!approved) {
    return NextResponse.json(
      { error: "That request expired. Ask the chat to try again." },
      { status: 410 },
    );
  }
  const run = await enqueueBotPrompt(botId, `Confirmed: ${approved.summary}. Go ahead.`);
  return NextResponse.json({ ok: true, runId: run.id });
}
