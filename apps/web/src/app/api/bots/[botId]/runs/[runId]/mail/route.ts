import { prisma } from "@nexux/db";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { cancelBotRun, enqueueBotPrompt } from "@/lib/bot-manager";
import { parseMailState, renderMailPrompt, toMailDraft, validAddresses, type MailState } from "@/lib/bot-mail";
import { splitReply } from "@/lib/bot-routines";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ botId: string; runId: string }> };

const schema = z.object({
  index: z.number().int().min(0).max(99),
  action: z.enum(["send", "draft", "discard"]),
  /** The card as the user left it (edits included). Required to send or save. */
  mail: z.unknown().optional(),
});

/**
 * Act on an email card in a bot's reply. Send / draft queue a run on the same
 * bot carrying the final text — the bot does it from Gmail in its browser.
 * Each card is acted on once; a send that failed or was stopped can be retried.
 */
export async function POST(req: NextRequest, { params }: Params) {
  const { botId, runId } = await params;
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "index and action are required" }, { status: 400 });
  const { index, action } = parsed.data;

  const run = await prisma.botRun.findFirst({
    where: { id: runId, botId },
    select: { id: true, status: true, result: true, mailState: true },
  });
  if (!run) return NextResponse.json({ error: "Run not found" }, { status: 404 });
  if (run.status !== "completed" || index >= splitReply(run.result).mails.length) {
    return NextResponse.json({ error: "No such email in this reply" }, { status: 404 });
  }
  const state = parseMailState(run.mailState);
  const prior = state[index];
  // Once per card — unless its send failed or was stopped, then it can be retried (not discarded).
  let retry = false;
  if (prior?.status === "sent" && action !== "discard") {
    const last = await prisma.botRun.findUnique({ where: { id: prior.runId }, select: { status: true } });
    retry = !last || last.status === "error" || last.status === "canceled";
  }
  if (prior && !retry)return NextResponse.json({ error: "This email was already handled" }, { status: 409 });

  let next: MailState;
  let queuedId: string | null = null;
  if (action === "discard") {
    next = { ...state, [index]: { status: "discarded" } };
  } else {
    const mail = toMailDraft(parsed.data.mail);
    if (!mail || !validAddresses(mail.to, { required: true }) || !validAddresses(mail.cc) || !validAddresses(mail.bcc)) {
      return NextResponse.json({ error: "The email needs a valid To address and a subject or body" }, { status: 400 });
    }
    try {
      const queued = await enqueueBotPrompt(botId, renderMailPrompt({ sourceRunId: run.id, index, mode: action, mail }));
      queuedId = queued.id;
    } catch (err) {
      return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 409 });
    }
    next = { ...state, [index]: { status: "sent", runId: queuedId, mode: action } };
  }

  // Only if nobody acted on the reply meanwhile — a double click must not send twice.
  const saved = await prisma.botRun.updateMany({
    where: { id: run.id, mailState: run.mailState },
    data: { mailState: JSON.stringify(next) },
  });
  if (saved.count === 0) {
    if (queuedId) await cancelBotRun(botId, queuedId);
    return NextResponse.json({ error: "This email was already handled" }, { status: 409 });
  }
  return NextResponse.json({ ok: true });
}
