// Emails a bot writes for the user to review (spec 31). The bot ends a reply
// with one block per email:
//
//   ```mail
//   {"from": "me@acme.com", "to": "ana@example.com", "cc": "", "subject": "…", "body": "…"}
//   ```
//
// The chat shows each one as an editable card with Discard and Send. Send
// queues a run on the same bot that carries the final text: the bot sends it
// from Gmail in its own browser, where it is signed in — Nexus holds no mail
// credentials. Pure and client-safe: the chat, the API and the manager share it.

export const MAIL_FENCE = "mail";

export type MailDraft = {
  from?: string;
  to: string;
  cc?: string;
  bcc?: string;
  subject: string;
  body: string;
  /** A reply in an existing Gmail conversation (spec 34: sent by the connector). */
  threadId?: string;
};

/** send: deliver it now. draft: leave it in Gmail's drafts. */
export type MailMode = "send" | "draft";

/** What happened to a card, kept on the run that wrote it (BotRun.mailState). */
export type MailState = Record<
  string,
  | { status: "discarded" }
  /** Handed to the bot: it sends from Gmail in its browser (runId is that run). */
  | { status: "sent"; runId: string; mode: MailMode }
  /** Done by Nexus through the Gmail connector (spec 34), as it went out. */
  | { status: "delivered"; mode: MailMode; mail: MailDraft; at: string }
>;

const BLOCK = new RegExp("```" + MAIL_FENCE + "[ \\t]*\\n([\\s\\S]*?)\\n?```", "g");

const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");

/** A draft from loose JSON, or null without a recipient or with nothing to say. */
export function toMailDraft(d: unknown): MailDraft | null {
  if (!d || typeof d !== "object") return null;
  const o = d as Record<string, unknown>;
  const to = str(o.to, 2000);
  const subject = str(o.subject, 500);
  const body = typeof o.body === "string" ? o.body.replace(/\s+$/, "").slice(0, 50_000) : "";
  if (!to || (!subject && !body.trim())) return null;
  const from = str(o.from, 320);
  const cc = str(o.cc, 2000);
  const bcc = str(o.bcc, 2000);
  const threadId = /^[A-Za-z0-9]{6,40}$/.test(str(o.threadId, 40)) ? str(o.threadId, 40) : "";
  return {
    ...(threadId ? { threadId } : {}),
    ...(from ? { from } : {}),
    to,
    ...(cc ? { cc } : {}),
    ...(bcc ? { bcc } : {}),
    subject,
    body: body.replace(/^\s*\n/, ""),
  };
}

/** Mail blocks in a reply, and the reply without them. Malformed blocks are dropped. */
export function parseMailBlocks(text: string | null | undefined): { body: string; mails: MailDraft[] } {
  if (!text) return { body: "", mails: [] };
  const mails: MailDraft[] = [];
  const body = text.replace(BLOCK, (_, json: string) => {
    try {
      const m = toMailDraft(JSON.parse(json.trim()));
      if (m) mails.push(m);
    } catch {
      // not JSON: ignore the block
    }
    return "";
  });
  return { body: body.trim(), mails };
}

/** Rough address check for the card: every comma/semicolon-separated part looks like one. */
export function validAddresses(list: string | undefined, { required = false } = {}): boolean {
  const parts = (list ?? "")
    .split(/[,;]/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length === 0) return !required;
  return parts.every((p) => /^(?:[^<>]*<\s*)?[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+\s*>?$/.test(p));
}

export function parseMailState(raw: string | null | undefined): MailState {
  if (!raw) return {};
  try {
    const d = JSON.parse(raw) as unknown;
    return d && typeof d === "object" && !Array.isArray(d) ? (d as MailState) : {};
  } catch {
    return {};
  }
}

// ---- The run that sends it -----------------------------------------------------

// [nexux:mail:<sourceRunId>:<index>:<mode>] <subject>
// <the final draft, as JSON>
const TAG = /^\[nexux:mail:([\w-]+):(\d+):(send|draft)\] ([^\n]*)\n([\s\S]*)$/;

export type MailRun = { sourceRunId: string; index: number; mode: MailMode; mail: MailDraft };

export function renderMailPrompt(m: MailRun): string {
  return `[nexux:mail:${m.sourceRunId}:${m.index}:${m.mode}] ${m.mail.subject.replace(/\n/g, " ")}\n${JSON.stringify(m.mail)}`;
}

export function mailRun(prompt: string): MailRun | null {
  if (!prompt.startsWith("[nexux:mail:")) return null;
  const m = prompt.match(TAG);
  if (!m) return null;
  try {
    const mail = toMailDraft(JSON.parse(m[5]!));
    return mail ? { sourceRunId: m[1]!, index: Number(m[2]), mode: m[3] as MailMode, mail } : null;
  } catch {
    return null;
  }
}

/** What the bot's Claude reads when the user approves an email on its card. */
export function mailForClaude(m: { mode: MailMode; mail: MailDraft }): string {
  const { mail } = m;
  const send = m.mode === "send";
  return [
    send
      ? "The user reviewed this email and pressed Send. Send it now from Gmail in your browser, exactly as written below — don't reword it."
      : "The user reviewed this email and chose Save as draft. Save it as a draft in Gmail in your browser, exactly as written below — do NOT send it.",
    "",
    `From: ${mail.from || "(the Google account you are signed in with)"}`,
    `To: ${mail.to}`,
    ...(mail.cc ? [`Cc: ${mail.cc}`] : []),
    ...(mail.bcc ? [`Bcc: ${mail.bcc}`] : []),
    `Subject: ${mail.subject}`,
    "",
    "Body (between the lines, verbatim):",
    "-----",
    mail.body,
    "-----",
    "",
    `- Open https://mail.google.com, Compose, and fill To${mail.cc ? ", Cc" : ""}${mail.bcc ? ", Bcc" : ""}, Subject and the body as plain text. Keep the line breaks. Don't add a signature the body doesn't have.`,
    mail.from
      ? `- Send from ${mail.from}: if Gmail is signed into another account, switch to it (or pick it in the From field). If it isn't signed in, ask the user to sign in on your screen.`
      : "- If Gmail isn't signed in, ask the user to sign in on your screen.",
    send
      ? '- After sending, check it shows in Sent. Reply with one short line (e.g. "Enviado a ana@example.com."). If it did not go out, say why.'
      : "- Close the compose window so it is saved in Drafts, and check it is there. Reply with one short line saying it is saved.",
    "- Don't write a mail block in this reply.",
  ].join("\n");
}
