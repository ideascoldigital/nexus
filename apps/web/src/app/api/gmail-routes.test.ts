import assert from "node:assert/strict";
import fs from "node:fs";
import { after, beforeEach, test } from "node:test";

// Env setup must stay above every other import (throwaway DB → ephemeral vault key).
import { testDbDir } from "./routes.test-setup";
import { NextRequest } from "next/server";
import { prisma } from "@nexux/db";

import { GET as getApp, PUT as putApp } from "./google/app/route";
import { POST as startOAuth } from "./google/oauth/start/route";
import { GET as callback } from "./google/oauth/callback/route";
import { GET as listAccounts } from "./google/accounts/route";
import { DELETE as disconnect, PATCH as patchAccount } from "./google/accounts/[accountId]/route";
import { GET as botAccounts, POST as botGmail } from "./bots/[botId]/gmail/route";
import { POST as actOnMail } from "./bots/[botId]/runs/[runId]/mail/route";
import { grantVault, revokeVault } from "@/lib/bot-vault-access";

// A fake Google: records what Nexus asked and answers like the real one.
type Call = { url: string; method: string; auth: string | null; body: string };
const calls: Call[] = [];
let refreshFails = false;
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  const body = typeof init?.body === "string" ? init.body : init?.body ? String(init.body) : "";
  const auth = new Headers(init?.headers).get("authorization");
  calls.push({ url, method: init?.method ?? "GET", auth, body });
  const json = (status: number, data: unknown) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
  if (url.startsWith("https://oauth2.googleapis.com/token")) {
    const p = new URLSearchParams(body);
    if (p.get("grant_type") === "refresh_token") {
      return refreshFails ? json(400, { error: "invalid_grant" }) : json(200, { access_token: "at-2", expires_in: 3600 });
    }
    return json(200, {
      access_token: "at-1",
      refresh_token: "rt-1",
      expires_in: -120, // already stale: the first call has to refresh
      scope: "openid email https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.compose",
    });
  }
  if (url.startsWith("https://openidconnect.googleapis.com/v1/userinfo")) return json(200, { email: "Me@Example.com" });
  if (url.startsWith("https://oauth2.googleapis.com/revoke")) return json(200, {});
  if (url.includes("/gmail/v1/users/me/messages/send")) return json(200, { id: "sent1", threadId: "t1" });
  if (url.includes("/gmail/v1/users/me/drafts")) return json(200, { id: "d1", message: { id: "m5", threadId: "t5" } });
  if (url.includes("/gmail/v1/users/me/threads/")) {
    return json(200, { id: "t1", messages: [{ id: "m1", threadId: "t1", payload: { headers: [{ name: "Message-ID", value: "<orig@mail>" }, { name: "Subject", value: "Hola" }], mimeType: "text/plain", body: { data: Buffer.from("cuerpo").toString("base64url") } } }] });
  }
  if (url.includes("/gmail/v1/users/me/messages?")) return json(200, { messages: [{ id: "m1" }], resultSizeEstimate: 1 });
  if (url.includes("/gmail/v1/users/me/messages/m1")) {
    return json(200, { id: "m1", threadId: "t1", snippet: "hola", labelIds: ["UNREAD"], payload: { headers: [{ name: "From", value: "Ana <ana@x.com>" }, { name: "Subject", value: "Hola" }] } });
  }
  return realFetch(input, init);
}) as typeof fetch;

after(async () => {
  globalThis.fetch = realFetch;
  await prisma.$disconnect();
  fs.rmSync(testDbDir, { recursive: true, force: true });
});

beforeEach(async () => {
  calls.length = 0;
  refreshFails = false;
  await prisma.connectedAccount.deleteMany({ where: { providerType: "google" } });
  await prisma.oAuthState.deleteMany({});
  await prisma.bot.deleteMany({});
});

const req = (url: string, method: string, body?: unknown, headers: Record<string, string> = {}) =>
  new NextRequest(`http://localhost:3100${url}`, {
    method,
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: { "content-type": "application/json", host: "localhost:3100", ...headers },
  });
const p = <T>(v: T) => ({ params: Promise.resolve(v) });

async function connect(): Promise<string> {
  await putApp(req("/api/google/app", "PUT", { clientId: "123-abc.apps.googleusercontent.com", clientSecret: "shh" }));
  const { url } = await (await startOAuth(req("/api/google/oauth/start", "POST", {}))).json();
  const state = new URL(url).searchParams.get("state")!;
  const res = await callback(req(`/api/google/oauth/callback?state=${state}&code=c0de`, "GET"));
  assert.equal(res.status, 200, await res.clone().text());
  const [account] = await (await listAccounts()).json();
  return account.id;
}

test("the OAuth app: validated, saved sealed, secret never returned", async () => {
  assert.deepEqual(await (await getApp()).json(), { configured: false, clientId: null });
  assert.equal((await putApp(req("/api/google/app", "PUT", { clientId: "nope", clientSecret: "x" }))).status, 400);
  assert.equal((await putApp(req("/api/google/app", "PUT", { clientId: "1-a.apps.googleusercontent.com" }))).status, 400);
  assert.equal((await startOAuth(req("/api/google/oauth/start", "POST", {}))).status, 409);
  await putApp(req("/api/google/app", "PUT", { clientId: "123-abc.apps.googleusercontent.com", clientSecret: "shh" }));
  const app = await (await getApp()).json();
  assert.deepEqual(app, { configured: true, clientId: "123-abc.apps.googleusercontent.com" });
  const rows = await prisma.$queryRaw<Array<{ value: string }>>`select value from Settings where key = 'google_client_secret'`;
  assert.ok(rows[0] && !rows[0].value.includes("shh"));
});

test("connecting: PKCE round-trip, tokens sealed at rest, one row per address", async () => {
  await putApp(req("/api/google/app", "PUT", { clientId: "123-abc.apps.googleusercontent.com", clientSecret: "shh" }));
  const { url } = await (await startOAuth(req("/api/google/oauth/start", "POST", {}))).json();
  const consent = new URL(url);
  assert.equal(consent.searchParams.get("redirect_uri"), "http://localhost:3100/api/google/oauth/callback");
  const state = consent.searchParams.get("state")!;

  // A forged or replayed state goes nowhere.
  assert.equal((await callback(req("/api/google/oauth/callback?state=forged&code=x", "GET"))).status, 400);
  assert.equal((await callback(req(`/api/google/oauth/callback?state=${state}&code=c0de`, "GET"))).status, 200);
  assert.equal((await callback(req(`/api/google/oauth/callback?state=${state}&code=c0de`, "GET"))).status, 400);

  const exchange = new URLSearchParams(calls.find((c) => c.url.includes("/token"))!.body);
  assert.equal(exchange.get("code"), "c0de");
  assert.ok((exchange.get("code_verifier") ?? "").length >= 43);

  const accounts = await (await listAccounts()).json();
  assert.equal(accounts.length, 1);
  assert.equal(accounts[0].email, "me@example.com");
  assert.equal(JSON.stringify(accounts).includes("rt-1"), false);
  const raw = await prisma.$queryRaw<Array<{ accessToken: string; refreshToken: string }>>`select accessToken, refreshToken from OAuthToken`;
  assert.ok(raw.every((r) => !r.accessToken.includes("at-1") && !r.refreshToken.includes("rt-1")));

  // Reconnecting the same address keeps the row (and who may use it).
  const bot = await prisma.bot.create({ data: { name: "Isa" } });
  await patchAccount(req("", "PATCH", { botIds: [bot.id] }), p({ accountId: accounts[0].id }));
  const again = await (await startOAuth(req("/api/google/oauth/start", "POST", {}))).json();
  await callback(req(`/api/google/oauth/callback?state=${new URL(again.url).searchParams.get("state")}&code=c0de`, "GET"));
  const after = await (await listAccounts()).json();
  assert.equal(after.length, 1);
  assert.deepEqual(after[0].botIds, [bot.id]);
  assert.equal(await prisma.oAuthToken.count(), 1);
});

test("a cancelled consent connects nothing", async () => {
  await putApp(req("/api/google/app", "PUT", { clientId: "123-abc.apps.googleusercontent.com", clientSecret: "shh" }));
  const { url } = await (await startOAuth(req("/api/google/oauth/start", "POST", {}))).json();
  const res = await callback(req(`/api/google/oauth/callback?state=${new URL(url).searchParams.get("state")}&error=access_denied`, "GET"));
  assert.equal(res.status, 400);
  assert.equal((await (await listAccounts()).json()).length, 0);
});

test("bots: only with a live run token, only accounts they may use; search, read, draft, send", async () => {
  const accountId = await connect();
  const isa = await prisma.bot.create({ data: { name: "Isa" } });
  const other = await prisma.bot.create({ data: { name: "Other" } });
  await patchAccount(req("", "PATCH", { botIds: [isa.id] }), p({ accountId }));

  const call = (botId: string, body: unknown, token?: string) =>
    botGmail(req(`/api/bots/${botId}/gmail`, "POST", body, token ? { "x-nexux-vault-token": token } : {}), p({ botId }));

  assert.equal((await call(isa.id, { tool: "search", query: "x" })).status, 401);
  const token = grantVault({ botId: isa.id, runId: "r1", container: "c", dockerHost: null });
  const otherToken = grantVault({ botId: other.id, runId: "r2", container: "c2", dockerHost: null });
  // Another bot's token does not open this bot's mailbox, and the other bot has no account.
  assert.equal((await call(isa.id, { tool: "search", query: "x" }, otherToken)).status, 401);
  assert.equal((await call(other.id, { tool: "search", query: "x" }, otherToken)).status, 403);

  const listed = await botAccounts(req(`/api/bots/${isa.id}/gmail`, "GET", undefined, { "x-nexux-vault-token": token }), p({ botId: isa.id }));
  assert.deepEqual(await listed.json(), ["me@example.com"]);

  const found = await (await call(isa.id, { tool: "search", query: "is:unread" }, token)).json();
  assert.equal(found.messages[0].subject, "Hola");
  assert.equal(found.messages[0].unread, true);
  // The stale token was refreshed once, then reused.
  assert.equal(calls.filter((c) => c.url.includes("/token") && c.body.includes("refresh_token")).length, 1);
  assert.ok(calls.filter((c) => c.url.includes("gmail.googleapis.com")).every((c) => c.auth === "Bearer at-2"));

  const thread = await (await call(isa.id, { tool: "read", threadId: "t1" }, token)).json();
  assert.equal(thread.messages[0].body, "cuerpo");
  assert.equal((await call(isa.id, { tool: "read" }, token)).status, 400);

  assert.equal((await call(isa.id, { tool: "send", to: "not-an-address", subject: "s" }, token)).status, 400);
  assert.equal((await call(isa.id, { tool: "send", to: "ana@x.com", account: "someone@else.com", subject: "s" }, token)).status, 403);
  const draft = await (await call(isa.id, { tool: "draft", to: "ana@x.com", subject: "Hola", body: "b" }, token)).json();
  assert.equal(draft.draftId, "d1");

  const sent = await (await call(isa.id, { tool: "send", to: "ana@x.com", subject: "Re: Hola", body: "Gracias", threadId: "t1" }, token)).json();
  assert.equal(sent.messageId, "sent1");
  const out = JSON.parse(calls.find((c) => c.url.endsWith("/messages/send"))!.body);
  assert.equal(out.threadId, "t1");
  const mime = Buffer.from(out.raw, "base64url").toString("utf8");
  assert.match(mime, /^From: me@example\.com$/m);
  assert.match(mime, /^In-Reply-To: <orig@mail>$/m);

  revokeVault(token);
  revokeVault(otherToken);
  assert.equal((await call(isa.id, { tool: "search", query: "x" }, token)).status, 401);
});

test("a revoked grant marks the account expired and tells the bot to reconnect", async () => {
  await connect();
  const bot = await prisma.bot.create({ data: { name: "Isa" } });
  const token = grantVault({ botId: bot.id, runId: "r", container: "c", dockerHost: null });
  refreshFails = true;
  const res = await botGmail(req(`/api/bots/${bot.id}/gmail`, "POST", { tool: "search", query: "x" }, { "x-nexux-vault-token": token }), p({ botId: bot.id }));
  assert.equal(res.status, 409);
  assert.match((await res.json()).error, /Reconnect/);
  assert.equal((await (await listAccounts()).json())[0].status, "expired");
  revokeVault(token);
});

test("an email card from a connected address is sent by Nexus at once, and only once", async () => {
  await connect();
  const bot = await prisma.bot.create({ data: { name: "Isa" } });
  const reply = 'Listo.\n\n```mail\n{"from": "me@example.com", "to": "ana@x.com", "subject": "Hola", "body": "Hola Ana"}\n```';
  const session = await prisma.botSession.create({ data: { botId: bot.id, status: "stopped", containerName: "c-mail" } });
  const run = await prisma.botRun.create({ data: { botId: bot.id, sessionId: session.id, prompt: "escribe", status: "completed", result: reply } });
  const act = () =>
    actOnMail(
      req(`/api/bots/${bot.id}/runs/${run.id}/mail`, "POST", { index: 0, action: "send", mail: { from: "me@example.com", to: "ana@x.com", subject: "Hola", body: "Hola Ana, editado" } }),
      p({ botId: bot.id, runId: run.id }),
    );
  const res = await act();
  assert.deepEqual(await res.json(), { ok: true, delivered: true });
  const state = JSON.parse((await prisma.botRun.findUniqueOrThrow({ where: { id: run.id } })).mailState!);
  assert.equal(state[0].status, "delivered");
  assert.equal(state[0].mail.body, "Hola Ana, editado");
  // No bot run was queued for it, and a second press does nothing.
  assert.equal(await prisma.botRun.count({ where: { botId: bot.id } }), 1);
  assert.equal((await act()).status, 409);
  assert.equal(calls.filter((c) => c.url.endsWith("/messages/send")).length, 1);
});

test("disconnecting revokes at Google and forgets the tokens", async () => {
  const accountId = await connect();
  assert.equal((await disconnect(req("", "DELETE"), p({ accountId }))).status, 200);
  assert.ok(calls.some((c) => c.url.startsWith("https://oauth2.googleapis.com/revoke")));
  assert.equal(await prisma.oAuthToken.count(), 0);
  assert.equal((await disconnect(req("", "DELETE"), p({ accountId }))).status, 404);
  assert.equal((await patchAccount(req("", "PATCH", { botIds: null }), p({ accountId }))).status, 404);
});
