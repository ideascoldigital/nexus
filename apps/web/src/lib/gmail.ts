// The Gmail connector (spec 34), the pure half: the OAuth URL, PKCE, building
// an RFC 2822 message for the API and reading messages back into something a
// bot can use. No I/O here — services/google.ts does the calls.
//
// The connector exists because Google signs a bot's browser out of Gmail
// whenever its computer is reset (a fresh Linux Chromium on a new machine id
// looks like a stolen session). With the API, the user connects once: Nexus
// keeps the refresh token sealed (spec 32) and the bot asks Nexus, holding a
// token that is valid only while one of its prompts runs.

import { createHash, randomBytes } from "node:crypto";

export const GOOGLE_AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const GOOGLE_REVOKE_URL = "https://oauth2.googleapis.com/revoke";
export const GOOGLE_USERINFO_URL = "https://openidconnect.googleapis.com/v1/userinfo";
export const GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users/me";

/** Read + drafts + send (compose covers both). No label or delete rights. */
export const GOOGLE_SCOPES = [
  "openid",
  "email",
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.compose",
];

/** The callback path; Desktop OAuth clients accept any loopback port. */
export const GOOGLE_CALLBACK_PATH = "/api/google/oauth/callback";

// ---- OAuth ---------------------------------------------------------------------

export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(48).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

export function googleAuthUrl(opts: {
  clientId: string;
  redirectUri: string;
  state: string;
  challenge: string;
  loginHint?: string;
}): string {
  const url = new URL(GOOGLE_AUTHORIZE_URL);
  url.searchParams.set("client_id", opts.clientId);
  url.searchParams.set("redirect_uri", opts.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", GOOGLE_SCOPES.join(" "));
  url.searchParams.set("state", opts.state);
  url.searchParams.set("code_challenge", opts.challenge);
  url.searchParams.set("code_challenge_method", "S256");
  // offline + consent: always hand back a refresh token, also on a reconnect.
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  if (opts.loginHint) url.searchParams.set("login_hint", opts.loginHint);
  return url.toString();
}

/** Every Gmail scope we need was granted (the consent screen lets the user untick some). */
export function missingScopes(granted: string | null | undefined): string[] {
  const have = new Set((granted ?? "").split(/\s+/).filter(Boolean));
  return GOOGLE_SCOPES.filter((s) => s.startsWith("https://") && !have.has(s));
}

/** The client id Google shows for a Desktop / Web OAuth client. */
export function looksLikeClientId(v: string): boolean {
  return /^[0-9]+-[a-z0-9]+\.apps\.googleusercontent\.com$/.test(v.trim());
}

// ---- Building a message --------------------------------------------------------

export type OutgoingMail = {
  from: string;
  to: string;
  cc?: string;
  bcc?: string;
  subject: string;
  body: string;
  /** Reply in a thread: the Message-ID being answered, and the chain before it. */
  inReplyTo?: string;
  references?: string;
};

/** RFC 2047 for a header that is not plain ASCII. */
export function encodeHeader(v: string): string {
  if (/^[\x20-\x7e]*$/.test(v)) return v;
  return `=?UTF-8?B?${Buffer.from(v, "utf8").toString("base64")}?=`;
}

/** No header injection: a value never carries a line break. */
const oneLine = (v: string) => v.replace(/[\r\n]+/g, " ").trim();

/** The message as Gmail's API takes it: RFC 2822, base64url. */
export function buildRawMessage(m: OutgoingMail): string {
  const headers = [
    `From: ${oneLine(m.from)}`,
    `To: ${oneLine(m.to)}`,
    m.cc?.trim() ? `Cc: ${oneLine(m.cc)}` : null,
    m.bcc?.trim() ? `Bcc: ${oneLine(m.bcc)}` : null,
    `Subject: ${encodeHeader(oneLine(m.subject))}`,
    m.inReplyTo ? `In-Reply-To: ${oneLine(m.inReplyTo)}` : null,
    m.inReplyTo || m.references ? `References: ${oneLine([m.references, m.inReplyTo].filter(Boolean).join(" "))}` : null,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
  ].filter(Boolean);
  const body = Buffer.from(m.body.replace(/\r?\n/g, "\r\n"), "utf8")
    .toString("base64")
    .replace(/.{76}/g, "$&\r\n");
  return Buffer.from(`${headers.join("\r\n")}\r\n\r\n${body}`, "utf8").toString("base64url");
}

/** "Re: " once, the way mail clients do. */
export function replySubject(subject: string): string {
  return /^re:/i.test(subject.trim()) ? subject.trim() : `Re: ${subject.trim()}`;
}

/** The bare address in "Ana <ana@x.com>" or "ana@x.com". */
export function addressOf(v: string | null | undefined): string {
  const s = (v ?? "").trim();
  const m = s.match(/<([^>]+)>/);
  return (m ? m[1]! : s).trim().toLowerCase();
}

// ---- Reading messages ------------------------------------------------------------

type Part = {
  mimeType?: string;
  filename?: string;
  headers?: { name: string; value: string }[];
  body?: { data?: string; size?: number; attachmentId?: string };
  parts?: Part[];
};

export type GmailMessage = {
  id: string;
  threadId: string;
  labelIds?: string[];
  snippet?: string;
  internalDate?: string;
  payload?: Part;
};

export function header(msg: GmailMessage, name: string): string {
  const h = msg.payload?.headers?.find((x) => x.name.toLowerCase() === name.toLowerCase());
  return h?.value ?? "";
}

const decode = (data: string) => Buffer.from(data, "base64url").toString("utf8");

/** HTML to readable text — enough for a bot to read an email, not a renderer. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** The message's text: text/plain when there is one, else its HTML as text. */
export function messageText(msg: GmailMessage): string {
  const plain: string[] = [];
  const html: string[] = [];
  const walk = (p: Part | undefined) => {
    if (!p) return;
    if (p.filename) return; // an attachment, not the body
    if (p.mimeType === "text/plain" && p.body?.data) plain.push(decode(p.body.data));
    else if (p.mimeType === "text/html" && p.body?.data) html.push(decode(p.body.data));
    p.parts?.forEach(walk);
  };
  walk(msg.payload);
  if (plain.length) return plain.join("\n").trim();
  return htmlToText(html.join("\n"));
}

export function attachmentsOf(msg: GmailMessage): { filename: string; mimeType: string; size: number }[] {
  const out: { filename: string; mimeType: string; size: number }[] = [];
  const walk = (p: Part | undefined) => {
    if (!p) return;
    if (p.filename) out.push({ filename: p.filename, mimeType: p.mimeType ?? "", size: p.body?.size ?? 0 });
    p.parts?.forEach(walk);
  };
  walk(msg.payload);
  return out;
}

export type MessageSummary = {
  id: string;
  threadId: string;
  from: string;
  to: string;
  subject: string;
  date: string;
  snippet: string;
  unread: boolean;
};

export function summarize(msg: GmailMessage): MessageSummary {
  return {
    id: msg.id,
    threadId: msg.threadId,
    from: header(msg, "From"),
    to: header(msg, "To"),
    subject: header(msg, "Subject"),
    date: msg.internalDate ? new Date(Number(msg.internalDate)).toISOString() : header(msg, "Date"),
    snippet: msg.snippet ?? "",
    unread: msg.labelIds?.includes("UNREAD") ?? false,
  };
}

/** One message in full, for gmail_read. Long bodies are cut — a bot reads, it does not archive. */
export function readable(msg: GmailMessage, maxChars = 20_000) {
  const text = messageText(msg);
  return {
    ...summarize(msg),
    cc: header(msg, "Cc") || undefined,
    messageId: header(msg, "Message-ID") || header(msg, "Message-Id") || undefined,
    body: text.length > maxChars ? `${text.slice(0, maxChars)}\n…[cut at ${maxChars} characters]` : text,
    attachments: attachmentsOf(msg),
  };
}

// ---- Who may use an account ----------------------------------------------------

/** Like vault entries: no list means every bot. */
export function accountBotIds(metadata: unknown): string[] | null {
  const ids = (metadata as { botIds?: unknown } | null)?.botIds;
  return Array.isArray(ids) && ids.length ? ids.filter((x): x is string => typeof x === "string") : null;
}

export function botMayUseAccount(metadata: unknown, botId: string): boolean {
  const ids = accountBotIds(metadata);
  return ids === null || ids.includes(botId);
}

export function accountEmail(metadata: unknown): string {
  const e = (metadata as { email?: unknown } | null)?.email;
  return typeof e === "string" ? e : "";
}
