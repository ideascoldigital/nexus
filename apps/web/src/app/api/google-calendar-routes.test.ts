import assert from "node:assert/strict";
import fs from "node:fs";
import { after, beforeEach, test } from "node:test";

// Env setup must stay above every other import (throwaway DB → ephemeral vault key).
import { testDbDir } from "./routes.test-setup";
import { NextRequest } from "next/server";
import { prisma } from "@nexux/db";

import { PUT as putApp } from "./google/app/route";
import { POST as startOAuth } from "./google/oauth/start/route";
import { GET as callback } from "./google/oauth/callback/route";
import { GET as listAccounts } from "./google/accounts/route";
import { PATCH as patchAccount } from "./google/accounts/[accountId]/route";
import { GET as calendarAccounts, POST as botCalendar } from "./bots/[botId]/calendar/route";
import { GET as gmailAccounts } from "./bots/[botId]/gmail/route";
import { GET as connectorList } from "./connectors/route";
import { grantVault, revokeVault } from "@/lib/bot-vault-access";

const GMAIL = "https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.compose";
const CALENDAR = "https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/calendar.readonly";

// A fake Google: hands out whatever scopes the test says were granted, and
// answers Calendar like the real API.
type Call = { url: string; method: string; auth: string | null; body: string };
const calls: Call[] = [];
let granted = `openid email ${GMAIL}`;
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  const body = typeof init?.body === "string" ? init.body : init?.body ? String(init.body) : "";
  calls.push({ url, method: init?.method ?? "GET", auth: new Headers(init?.headers).get("authorization"), body });
  const json = (status: number, data: unknown) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
  if (url.startsWith("https://oauth2.googleapis.com/token")) {
    return json(200, { access_token: "at-1", refresh_token: "rt-1", expires_in: 3600, scope: granted });
  }
  if (url.startsWith("https://openidconnect.googleapis.com/v1/userinfo")) return json(200, { email: "me@example.com" });
  if (url.includes("/calendar/v3/users/me/calendarList")) {
    return json(200, { items: [{ id: "me@example.com", summary: "Me", primary: true, accessRole: "owner", timeZone: "America/Bogota" }] });
  }
  if (url.includes("/calendar/v3/freeBusy")) {
    return json(200, { calendars: { primary: { busy: [{ start: "2026-11-24T15:00:00Z", end: "2026-11-24T16:00:00Z" }] }, "ana@x.com": { errors: [{ reason: "notFound" }] } } });
  }
  if (url.includes("/calendar/v3/calendars/primary/events") && (init?.method ?? "GET") === "GET" && !url.includes("/events/")) {
    return json(200, { timeZone: "America/Bogota", items: [{ id: "e1", summary: "Standup", start: { dateTime: "2026-11-24T09:00:00-05:00" }, end: { dateTime: "2026-11-24T09:15:00-05:00" } }] });
  }
  if (url.includes("/calendar/v3/calendars/primary/events") && init?.method === "POST") {
    const ev = JSON.parse(body);
    return json(200, { id: "new1", ...ev, htmlLink: "https://calendar.google.com/e/new1" });
  }
  if (url.includes("/events/gone")) return json(410, { error: { message: "Resource has been deleted" } });
  if (url.includes("/calendar/v3/calendars/primary/events/e1") && init?.method === "PATCH") {
    return json(200, { id: "e1", summary: "Standup", ...JSON.parse(body) });
  }
  if (url.includes("/calendar/v3/calendars/primary/events/e1") && init?.method === "DELETE") return new Response(null, { status: 204 });
  return realFetch(input, init);
}) as typeof fetch;

after(async () => {
  globalThis.fetch = realFetch;
  await prisma.$disconnect();
  fs.rmSync(testDbDir, { recursive: true, force: true });
});

beforeEach(async () => {
  calls.length = 0;
  granted = `openid email ${GMAIL}`;
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

/** One consent round-trip asking for `apps`; Google grants whatever `granted` says. */
async function consent(apps: string[] | undefined) {
  await putApp(req("/api/google/app", "PUT", { clientId: "123-abc.apps.googleusercontent.com", clientSecret: "shh" }));
  const { url } = await (await startOAuth(req("/api/google/oauth/start", "POST", apps ? { apps } : {}))).json();
  const state = new URL(url).searchParams.get("state")!;
  return { url: new URL(url), res: await callback(req(`/api/google/oauth/callback?state=${state}&code=c0de`, "GET")) };
}

test("Calendar is added to a Gmail account with one more consent, keeping Gmail", async () => {
  await consent(undefined);
  let [account] = await (await listAccounts()).json();
  assert.deepEqual(account.apps, ["gmail"]);

  // Google's incremental consent hands back a token with both.
  granted = `openid email ${GMAIL} ${CALENDAR}`;
  const { url, res } = await consent(["calendar"]);
  assert.match(url.searchParams.get("scope")!, /calendar\.events/);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /Gmail and Google Calendar/);

  const accounts = await (await listAccounts()).json();
  assert.equal(accounts.length, 1, "the same address, not a second row");
  [account] = accounts;
  assert.deepEqual(account.apps, ["gmail", "calendar"]);
  const connectors = await (await connectorList()).json();
  assert.equal(connectors.find((c: { id: string }) => c.id === "google-calendar").connected, true);
});

test("a consent with Calendar unticked is refused, and connects nothing new", async () => {
  granted = "openid email https://www.googleapis.com/auth/calendar.readonly";
  const { res } = await consent(["calendar"]);
  assert.equal(res.status, 400);
  assert.match(await res.text(), /Google Calendar permission/);
  assert.equal((await (await listAccounts()).json()).length, 0);
});

test("a Calendar-only account is not offered to bots as Gmail, nor the reverse", async () => {
  granted = `openid email ${CALENDAR}`;
  await consent(["calendar"]);
  const bot = await prisma.bot.create({ data: { name: "Agenda" } });
  const token = grantVault({ botId: bot.id, runId: "r1", container: "c", dockerHost: null });
  const h = { "x-nexux-vault-token": token };
  assert.deepEqual(await (await calendarAccounts(req("", "GET", undefined, h), p({ botId: bot.id }))).json(), ["me@example.com"]);
  assert.deepEqual(await (await gmailAccounts(req("", "GET", undefined, h), p({ botId: bot.id }))).json(), []);
  revokeVault(token);
});

test("bots: agenda, free/busy, create, move and delete — only with a live run token and an allowed account", async () => {
  granted = `openid email ${GMAIL} ${CALENDAR}`;
  await consent(["gmail", "calendar"]);
  const [account] = await (await listAccounts()).json();
  const isa = await prisma.bot.create({ data: { name: "Isa" } });
  const other = await prisma.bot.create({ data: { name: "Other" } });
  await patchAccount(req("", "PATCH", { botIds: [isa.id] }), p({ accountId: account.id }));

  const call = (botId: string, body: unknown, token?: string) =>
    botCalendar(req(`/api/bots/${botId}/calendar`, "POST", body, token ? { "x-nexux-vault-token": token } : {}), p({ botId }));
  const window = { timeMin: "2026-11-24T00:00:00-05:00", timeMax: "2026-11-25T00:00:00-05:00" };

  assert.equal((await call(isa.id, { tool: "calendars" })).status, 401, "no run, no calendar");
  const token = grantVault({ botId: isa.id, runId: "r1", container: "c", dockerHost: null });
  const otherToken = grantVault({ botId: other.id, runId: "r2", container: "c2", dockerHost: null });
  assert.equal((await call(isa.id, { tool: "calendars" }, otherToken)).status, 401, "another bot's token");
  assert.equal((await call(other.id, { tool: "calendars" }, otherToken)).status, 403, "a bot the account is not shared with");

  const cals = await (await call(isa.id, { tool: "calendars" }, token)).json();
  assert.equal(cals[0].primary, true);
  assert.ok(calls.filter((c) => c.url.includes("/calendar/v3/")).every((c) => c.auth === "Bearer at-1"));

  const agenda = await (await call(isa.id, { tool: "events", ...window }, token)).json();
  assert.equal(agenda.events[0].summary, "Standup");
  const listUrl = new URL(calls.find((c) => c.url.includes("/events?"))!.url);
  assert.equal(listUrl.searchParams.get("singleEvents"), "true", "recurring events expanded");
  assert.equal((await call(isa.id, { tool: "events", timeMin: "2026-11-24", timeMax: window.timeMax }, token)).status, 400);

  const busy = await (await call(isa.id, { tool: "freebusy", ...window, calendars: ["primary", "ana@x.com"] }, token)).json();
  assert.equal(busy.primary.busy.length, 1);
  assert.equal(busy["ana@x.com"].error, "notFound");

  // Create: wall-clock time in the user's zone, guests added but not emailed unless asked.
  const created = await (
    await call(isa.id, { tool: "create_event", summary: "Demo", start: "2026-11-24T10:00", end: "2026-11-24T10:30", attendees: "ana@x.com", meet: true }, token)
  ).json();
  assert.equal(created.id, "new1");
  const createCall = calls.find((c) => c.method === "POST" && c.url.includes("/events?"))!;
  const createUrl = new URL(createCall.url);
  assert.equal(createUrl.searchParams.get("sendUpdates"), "none");
  assert.equal(createUrl.searchParams.get("conferenceDataVersion"), "1");
  const sent = JSON.parse(createCall.body);
  assert.equal(sent.start.dateTime, "2026-11-24T10:00:00");
  assert.ok(sent.start.timeZone, "the user's zone is attached");
  assert.deepEqual(sent.attendees, [{ email: "ana@x.com" }]);

  assert.equal((await call(isa.id, { tool: "create_event", summary: "x", start: "2026-11-24T11:00", end: "2026-11-24T10:00" }, token)).status, 400);

  // Move, with the guests told.
  await call(isa.id, { tool: "update_event", eventId: "e1", start: "2026-11-24T11:00", end: "2026-11-24T11:15", notify: true }, token);
  const patch = calls.find((c) => c.method === "PATCH")!;
  assert.equal(new URL(patch.url).searchParams.get("sendUpdates"), "all");
  assert.deepEqual(Object.keys(JSON.parse(patch.body)).sort(), ["end", "start"], "only what changed");

  const deleted = await (await call(isa.id, { tool: "delete_event", eventId: "e1" }, token)).json();
  assert.match(deleted.message, /Deleted/);
  assert.equal((await call(isa.id, { tool: "delete_event", eventId: "gone" }, token)).status, 404);

  revokeVault(token);
  revokeVault(otherToken);
  assert.equal((await call(isa.id, { tool: "calendars" }, token)).status, 401, "the token dies with the run");
});
