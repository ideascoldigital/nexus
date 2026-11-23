/**
 * The Gmail connector (spec 34), the I/O half.
 *
 * The user creates a Desktop OAuth client in their own Google Cloud project
 * (internal to their Workspace: no Google review, no 7-day token expiry),
 * pastes its id/secret, and connects accounts through Google's consent screen
 * in their own browser. Storage: the app in Settings (google_client_id /
 * google_client_secret, sealed), each account as a ConnectedAccount
 * (providerType "google", metadata { email, botIds }) with one OAuthToken
 * (sealed), in-flight PKCE verifiers in OAuthState.
 *
 * Tokens never leave this process: bots reach Gmail through
 * /api/bots/:id/gmail/*, with a token valid only while one of their prompts runs.
 */

import { randomBytes } from "node:crypto";
import { prisma } from "@nexux/db";

import {
  accountEmail,
  botMayUseAccount,
  buildRawMessage,
  GMAIL_API,
  GOOGLE_REVOKE_URL,
  GOOGLE_TOKEN_URL,
  GOOGLE_USERINFO_URL,
  grantedApps,
  missingScopes,
  parseApps,
  readable,
  summarize,
  type GmailMessage,
  type GoogleApp,
  type OutgoingMail,
} from "@/lib/gmail";

const CLIENT_ID_KEY = "google_client_id";
const CLIENT_SECRET_KEY = "google_client_secret";
const PROVIDER = "google";
const STATE_TTL_MS = 10 * 60 * 1000;
/** Refresh a minute early rather than fail a call on the edge. */
const EXPIRY_SLACK_MS = 60_000;

// ---- The OAuth app ------------------------------------------------------------

export async function getGoogleApp(): Promise<{ clientId: string; clientSecret: string } | null> {
  const rows = await prisma.settings.findMany({
    where: { key: { in: [CLIENT_ID_KEY, CLIENT_SECRET_KEY] }, isActive: true },
  });
  const clientId = rows.find((r) => r.key === CLIENT_ID_KEY)?.value;
  const clientSecret = rows.find((r) => r.key === CLIENT_SECRET_KEY)?.value;
  return clientId && clientSecret ? { clientId, clientSecret } : null;
}

export async function saveGoogleApp(clientId: string, clientSecret: string): Promise<void> {
  const upsert = (key: string, value: string) =>
    prisma.settings.upsert({
      where: { key },
      create: { key, value, provider: PROVIDER, isActive: true },
      update: { value, isActive: true },
    });
  await prisma.$transaction([upsert(CLIENT_ID_KEY, clientId.trim()), upsert(CLIENT_SECRET_KEY, clientSecret.trim())]);
}

// ---- The round-trip -----------------------------------------------------------

export async function createGoogleState(verifier: string, redirectUri: string, apps: GoogleApp[] = ["gmail"]): Promise<string> {
  await prisma.oAuthState.deleteMany({ where: { provider: PROVIDER, expiresAt: { lt: new Date() } } });
  const state = randomBytes(24).toString("hex");
  await prisma.oAuthState.create({
    data: {
      state,
      provider: PROVIDER,
      codeVerifier: verifier,
      metadata: { redirectUri, apps },
      expiresAt: new Date(Date.now() + STATE_TTL_MS),
    },
  });
  return state;
}

/** Single use. Returns the PKCE verifier, the redirect_uri and the apps the round-trip started with. */
export async function consumeGoogleState(
  state: string,
): Promise<{ verifier: string; redirectUri: string; apps: GoogleApp[] }> {
  const row = await prisma.oAuthState.findUnique({ where: { state } });
  if (!row || row.provider !== PROVIDER) throw new Error("This sign-in link is not valid any more. Start again from Nexus.");
  await prisma.oAuthState.delete({ where: { id: row.id } });
  if (row.expiresAt < new Date()) throw new Error("This sign-in took too long. Start again from Nexus.");
  const meta = row.metadata as { redirectUri?: string; apps?: unknown } | null;
  const redirectUri = meta?.redirectUri;
  if (!row.codeVerifier || !redirectUri) throw new Error("This sign-in link is incomplete. Start again from Nexus.");
  // A state from before Calendar carries no apps: it was a Gmail connection.
  return { verifier: row.codeVerifier, redirectUri, apps: parseApps(meta?.apps) };
}

type TokenResponse = {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  token_type?: string;
  error?: string;
  error_description?: string;
};

async function tokenRequest(params: Record<string, string>): Promise<TokenResponse> {
  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params),
  });
  const json = (await res.json().catch(() => ({}))) as TokenResponse;
  if (!res.ok || !json.access_token) {
    const err = new Error(json.error_description || json.error || `Google answered ${res.status}`);
    (err as Error & { code?: string }).code = json.error;
    throw err;
  }
  return json;
}

const APP_NAMES: Record<GoogleApp, string> = { gmail: "Gmail", calendar: "Google Calendar" };

/** "Gmail and Google Calendar" — for messages. */
export function appNames(apps: GoogleApp[]): string {
  return apps.map((a) => APP_NAMES[a]).join(" and ");
}

/**
 * Code → tokens → the account, created or reconnected. Returns its email and
 * every app the new token covers — with incremental consent that includes the
 * ones granted on an earlier connection.
 */
export async function connectGoogleAccount(
  code: string,
  verifier: string,
  redirectUri: string,
  apps: GoogleApp[] = ["gmail"],
): Promise<{ email: string; apps: GoogleApp[] }> {
  const app = await getGoogleApp();
  if (!app) throw new Error("The Google OAuth app is not set up in Nexus.");
  const tok = await tokenRequest({
    grant_type: "authorization_code",
    code,
    code_verifier: verifier,
    redirect_uri: redirectUri,
    client_id: app.clientId,
    client_secret: app.clientSecret,
  });
  const missing = missingScopes(tok.scope, apps);
  if (missing.length) {
    const names = appNames(apps);
    throw new Error(`Google did not grant access to ${names}. Connect again and leave every ${names} permission ticked.`);
  }
  if (!tok.refresh_token) throw new Error("Google did not hand back a refresh token. Connect again.");

  const info = await fetch(GOOGLE_USERINFO_URL, { headers: { authorization: `Bearer ${tok.access_token}` } });
  const email = ((await info.json().catch(() => ({}))) as { email?: string }).email?.toLowerCase();
  if (!info.ok || !email) throw new Error("Could not read which Google account this is.");

  // One row per address: a reconnect keeps who may use it.
  const existing = (await prisma.connectedAccount.findMany({ where: { providerType: PROVIDER } })).find(
    (a) => accountEmail(a.metadata) === email,
  );
  const tokenData = {
    accessToken: tok.access_token,
    refreshToken: tok.refresh_token,
    tokenType: tok.token_type ?? "Bearer",
    expiresAt: tok.expires_in ? new Date(Date.now() + tok.expires_in * 1000) : null,
    scope: tok.scope ?? null,
  };
  if (existing) {
    await prisma.oAuthToken.deleteMany({ where: { accountId: existing.id } });
    await prisma.oAuthToken.create({ data: { accountId: existing.id, ...tokenData } });
    await prisma.connectedAccount.update({
      where: { id: existing.id },
      data: { status: "connected", lastCheckedAt: new Date() },
    });
  } else {
    const account = await prisma.connectedAccount.create({
      data: {
        providerType: PROVIDER,
        label: email,
        authMode: "oauth",
        status: "connected",
        metadata: { email },
        lastCheckedAt: new Date(),
      },
    });
    // Top-level create, so the vault extension seals both tokens.
    await prisma.oAuthToken.create({ data: { accountId: account.id, ...tokenData } });
  }
  return { email, apps: grantedApps(tok.scope) };
}

// ---- Accounts -----------------------------------------------------------------

export type GoogleAccount = {
  id: string;
  email: string;
  status: string;
  botIds: string[] | null;
  /** The apps its token was granted (spec 36): read off the token's scopes. */
  apps: GoogleApp[];
  createdAt: string;
};

type AccountRow = {
  id: string;
  status: string;
  metadata: unknown;
  createdAt: Date;
  oauthTokens?: { scope: string | null }[];
};

function toAccount(a: AccountRow): GoogleAccount {
  const ids = (a.metadata as { botIds?: unknown } | null)?.botIds;
  return {
    id: a.id,
    email: accountEmail(a.metadata),
    status: a.status,
    botIds: Array.isArray(ids) && ids.length ? (ids as string[]) : null,
    apps: grantedApps(a.oauthTokens?.[0]?.scope),
    createdAt: a.createdAt.toISOString(),
  };
}

// The scope only: tokens stay sealed and unread unless a call needs one.
const withScope = { oauthTokens: { select: { scope: true }, orderBy: { createdAt: "desc" as const }, take: 1 } };

export async function listGoogleAccounts(): Promise<GoogleAccount[]> {
  const rows = await prisma.connectedAccount.findMany({
    where: { providerType: PROVIDER },
    orderBy: { createdAt: "asc" },
    include: withScope,
  });
  return rows.map(toAccount);
}

/** The connected accounts a bot may use for one app (Gmail unless said). */
export async function googleAccountsFor(botId: string, app: GoogleApp = "gmail"): Promise<GoogleAccount[]> {
  return (await listGoogleAccounts()).filter(
    (a) => a.status === "connected" && a.apps.includes(app) && botMayUseAccount({ botIds: a.botIds }, botId),
  );
}

export async function setGoogleAccountBots(id: string, botIds: string[] | null): Promise<GoogleAccount | null> {
  const row = await prisma.connectedAccount.findFirst({ where: { id, providerType: PROVIDER } });
  if (!row) return null;
  const metadata = { ...((row.metadata as Record<string, unknown> | null) ?? {}), botIds: botIds?.length ? botIds : null };
  return toAccount(await prisma.connectedAccount.update({ where: { id }, data: { metadata }, include: withScope }));
}

/** Revoke at Google (best effort) and forget it here. */
export async function disconnectGoogleAccount(id: string): Promise<boolean> {
  const row = await prisma.connectedAccount.findFirst({
    where: { id, providerType: PROVIDER },
    include: { oauthTokens: true },
  });
  if (!row) return false;
  const token = row.oauthTokens[0]?.refreshToken ?? row.oauthTokens[0]?.accessToken;
  if (token) {
    await fetch(GOOGLE_REVOKE_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token }),
    }).catch(() => undefined);
  }
  await prisma.connectedAccount.delete({ where: { id } });
  return true;
}

// ---- Calls --------------------------------------------------------------------

/** A Google API call that failed, with the status to answer the bot with. */
export class GoogleApiError extends Error {
  constructor(message: string, readonly status = 502) {
    super(message);
  }
}
/** Gmail's name for it, from before Calendar shared the class. */
export { GoogleApiError as GmailError };

/** A live access token, refreshed when it is about to expire. */
export async function accessToken(accountId: string): Promise<string> {
  const token = await prisma.oAuthToken.findFirst({ where: { accountId }, orderBy: { createdAt: "desc" } });
  if (!token) throw new GoogleApiError("This Google account is not connected any more. Reconnect it in Nexus → Vault.", 409);
  if (token.expiresAt && token.expiresAt.getTime() - EXPIRY_SLACK_MS > Date.now()) return token.accessToken;
  const app = await getGoogleApp();
  if (!app || !token.refreshToken) throw new GoogleApiError("Reconnect this Google account in Nexus → Vault.", 409);
  try {
    const tok = await tokenRequest({
      grant_type: "refresh_token",
      refresh_token: token.refreshToken,
      client_id: app.clientId,
      client_secret: app.clientSecret,
    });
    await prisma.oAuthToken.update({
      where: { id: token.id },
      data: {
        accessToken: tok.access_token,
        expiresAt: tok.expires_in ? new Date(Date.now() + tok.expires_in * 1000) : null,
        ...(tok.refresh_token ? { refreshToken: tok.refresh_token } : {}),
      },
    });
    return tok.access_token;
  } catch (err) {
    // Revoked by the user at Google, or the app's secret changed.
    if ((err as { code?: string }).code === "invalid_grant") {
      await prisma.connectedAccount.update({ where: { id: accountId }, data: { status: "expired" } });
      throw new GoogleApiError("Google revoked Nexus's access to this account. Reconnect it in Nexus → Vault.", 409);
    }
    throw new GoogleApiError(`Could not refresh the Google token: ${err instanceof Error ? err.message : err}`);
  }
}

async function gmail<T>(accountId: string, path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const res = await fetch(`${GMAIL_API}${path}`, {
    method: init?.method ?? "GET",
    headers: {
      authorization: `Bearer ${await accessToken(accountId)}`,
      ...(init?.body ? { "content-type": "application/json" } : {}),
    },
    body: init?.body ? JSON.stringify(init.body) : undefined,
  });
  const json = (await res.json().catch(() => ({}))) as T & { error?: { message?: string } };
  if (!res.ok) throw new GoogleApiError(`Gmail: ${json.error?.message ?? `HTTP ${res.status}`}`, res.status === 404 ? 404 : 502);
  return json;
}

const MAX_RESULTS = 25;

/** Gmail's own search syntax (from:, is:unread, newer_than:7d…). */
export async function searchMail(accountId: string, query: string, max = 10) {
  const n = Math.min(Math.max(1, Math.floor(max) || 10), MAX_RESULTS);
  const list = await gmail<{ messages?: { id: string }[]; resultSizeEstimate?: number }>(
    accountId,
    `/messages?maxResults=${n}&q=${encodeURIComponent(query)}`,
  );
  const ids = list.messages?.map((m) => m.id) ?? [];
  const msgs = await Promise.all(
    ids.map((id) =>
      gmail<GmailMessage>(
        accountId,
        `/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Date`,
      ),
    ),
  );
  return { estimate: list.resultSizeEstimate ?? ids.length, messages: msgs.map(summarize) };
}

/** A whole thread, oldest first. */
export async function readThread(accountId: string, threadId: string) {
  const t = await gmail<{ id: string; messages?: GmailMessage[] }>(accountId, `/threads/${encodeURIComponent(threadId)}?format=full`);
  return { threadId: t.id, messages: (t.messages ?? []).map((m) => readable(m)) };
}

export async function readMessage(accountId: string, messageId: string) {
  return readable(await gmail<GmailMessage>(accountId, `/messages/${encodeURIComponent(messageId)}?format=full`));
}

/** Threading headers for a reply: the Message-ID it answers, and the chain. */
async function replyHeaders(accountId: string, threadId: string) {
  const t = await gmail<{ messages?: GmailMessage[] }>(
    accountId,
    `/threads/${encodeURIComponent(threadId)}?format=metadata&metadataHeaders=Message-ID&metadataHeaders=References`,
  );
  const last = t.messages?.at(-1);
  const h = (n: string) => last?.payload?.headers?.find((x) => x.name.toLowerCase() === n.toLowerCase())?.value;
  return { inReplyTo: h("Message-ID"), references: h("References") };
}

export type MailRequest = Omit<OutgoingMail, "inReplyTo" | "references"> & { threadId?: string };

async function rawFor(accountId: string, m: MailRequest) {
  const threading = m.threadId ? await replyHeaders(accountId, m.threadId) : {};
  return { raw: buildRawMessage({ ...m, ...threading }), ...(m.threadId ? { threadId: m.threadId } : {}) };
}

export async function createDraft(accountId: string, m: MailRequest) {
  const d = await gmail<{ id: string; message?: { id: string; threadId: string } }>(accountId, "/drafts", {
    method: "POST",
    body: { message: await rawFor(accountId, m) },
  });
  return { draftId: d.id, messageId: d.message?.id, threadId: d.message?.threadId };
}

export async function sendMail(accountId: string, m: MailRequest) {
  const s = await gmail<{ id: string; threadId: string }>(accountId, "/messages/send", {
    method: "POST",
    body: await rawFor(accountId, m),
  });
  return { messageId: s.id, threadId: s.threadId };
}
