import { prisma } from "@nexux/db";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { checkVault } from "@/lib/bot-vault-access";
import { validAddresses } from "@/lib/bot-mail";
import { addressOf } from "@/lib/gmail";
import {
  createDraft,
  GmailError,
  googleAccountsFor,
  readMessage,
  readThread,
  searchMail,
  sendMail,
  type GoogleAccount,
} from "@/services/google";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ botId: string }> };

const TOKEN_HEADER = "x-nexux-vault-token";

/**
 * The Gmail MCP server inside a bot's computer relays here (spec 34). It holds
 * no Google token, only the token of the prompt the bot is running now; Nexus
 * makes the call with the account's own token, refreshed and sealed here.
 */
export async function GET(req: NextRequest, { params }: Params) {
  const { botId } = await params;
  if (!checkVault(req.headers.get(TOKEN_HEADER), botId)) {
    return NextResponse.json({ error: "gmail: not available outside a running task" }, { status: 401 });
  }
  return NextResponse.json((await googleAccountsFor(botId)).map((a) => a.email));
}

const mail = {
  account: z.string().optional(),
  to: z.string().min(3).max(2000),
  cc: z.string().max(2000).optional(),
  bcc: z.string().max(2000).optional(),
  subject: z.string().max(500).default(""),
  body: z.string().max(50_000).default(""),
  threadId: z.string().max(200).optional(),
};

const schema = z.discriminatedUnion("tool", [
  z.object({ tool: z.literal("search"), account: z.string().optional(), query: z.string().max(500).default(""), max: z.number().int().min(1).max(25).optional() }),
  z.object({ tool: z.literal("read"), account: z.string().optional(), threadId: z.string().max(200).optional(), messageId: z.string().max(200).optional() }),
  z.object({ tool: z.literal("draft"), ...mail }),
  z.object({ tool: z.literal("send"), ...mail }),
]);

/** The account a call is for: the one named, or the only one this bot may use. */
function pick(accounts: GoogleAccount[], wanted: string | undefined): GoogleAccount | string {
  if (!accounts.length) return "No Gmail account is connected for you. Ask the user to connect one in Nexus → Vault.";
  if (wanted?.trim()) {
    const a = accounts.find((x) => x.email === addressOf(wanted));
    return a ?? `You can't use ${wanted}. Your accounts: ${accounts.map((x) => x.email).join(", ")}.`;
  }
  if (accounts.length === 1) return accounts[0]!;
  return `Say which account (account: …). Yours: ${accounts.map((x) => x.email).join(", ")}.`;
}

export async function POST(req: NextRequest, { params }: Params) {
  const { botId } = await params;
  if (!checkVault(req.headers.get(TOKEN_HEADER), botId)) {
    return NextResponse.json({ error: "gmail: not available outside a running task" }, { status: 401 });
  }
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: `gmail: ${parsed.error.issues.map((i) => `${i.path.join(".") || "input"} ${i.message}`).join("; ")}` }, { status: 400 });
  }
  const call = parsed.data;
  const account = pick(await googleAccountsFor(botId), call.account);
  if (typeof account === "string") return NextResponse.json({ error: account }, { status: 403 });

  try {
    if (call.tool === "search") return NextResponse.json(await searchMail(account.id, call.query, call.max));
    if (call.tool === "read") {
      if (call.threadId) return NextResponse.json(await readThread(account.id, call.threadId));
      if (call.messageId) return NextResponse.json(await readMessage(account.id, call.messageId));
      return NextResponse.json({ error: "gmail_read needs a threadId or a messageId" }, { status: 400 });
    }
    if (!validAddresses(call.to, { required: true }) || !validAddresses(call.cc) || !validAddresses(call.bcc)) {
      return NextResponse.json({ error: "gmail: to, cc and bcc must be email addresses, comma-separated" }, { status: 400 });
    }
    if (!call.subject.trim() && !call.body.trim()) {
      return NextResponse.json({ error: "gmail: the email needs a subject or a body" }, { status: 400 });
    }
    const out = { from: account.email, to: call.to, cc: call.cc, bcc: call.bcc, subject: call.subject, body: call.body, threadId: call.threadId };
    if (call.tool === "draft") {
      const d = await createDraft(account.id, out);
      return NextResponse.json({ ...d, message: `Saved as a draft in ${account.email}.` });
    }
    const bot = await prisma.bot.findUnique({ where: { id: botId }, select: { name: true } });
    const s = await sendMail(account.id, out);
    console.log(`[gmail] ${bot?.name ?? botId} sent an email from ${account.email}`);
    return NextResponse.json({ ...s, message: `Sent from ${account.email}.` });
  } catch (err) {
    if (err instanceof GmailError) return NextResponse.json({ error: err.message }, { status: err.status });
    throw err;
  }
}
