import assert from "node:assert/strict";
import fs from "node:fs";
import { after, before, beforeEach, test } from "node:test";

// Env setup must stay above every other import — the route modules reach
// @nexux/db, whose client is built (and migrated) at module load. The bots
// routes also resolve the active workspace (D-87), and `cookies()` throws
// outside a request scope, which is where these tests call handlers from —
// hence the workspace flavour of the setup, which sets the override first.
import { setActiveWorkspace, testDbDir } from "./workspace-routes.test-setup";
import { NextRequest } from "next/server";
import { prisma } from "@nexux/db";

import { GET as listBots, POST as createBot } from "./bots/route";
import { DELETE as deleteBot, GET as getBot, PATCH as patchBot } from "./bots/[botId]/route";
import { GET as feed, POST as sendPrompt } from "./bots/[botId]/runs/route";
import { DELETE as cancelRun } from "./bots/[botId]/runs/[runId]/route";
import { POST as actOnMail } from "./bots/[botId]/runs/[runId]/mail/route";
import { PATCH as touchSession } from "./bots/[botId]/session/route";
import { GET as listRoutines, POST as createRoutine } from "./bots/[botId]/routines/route";
import { DELETE as deleteRoutine, PATCH as patchRoutine } from "./bots/[botId]/routines/[routineId]/route";
import { applyRoutineSpecs } from "@/lib/bot-routine-store";
import { GET as botFile } from "./bots/[botId]/files/[runId]/[name]/route";
import { botFilesDir } from "@/lib/bot-files";
import { deliverHandoffs, fireDueRoutines, isIdleExpired, planRecovery, reapIdleBots } from "@/lib/bot-manager";

after(async () => {
  await prisma.$disconnect();
  fs.rmSync(testDbDir, { recursive: true, force: true });
});

const ALT_WORKSPACE = "ws-alt";

before(async () => {
  // The default workspace is seeded by the migrations; add a second one.
  await prisma.workspace.upsert({
    where: { id: ALT_WORKSPACE },
    update: {},
    create: { id: ALT_WORKSPACE, name: "Alternate" },
  });
});

beforeEach(async () => {
  await prisma.bot.deleteMany({});
  setActiveWorkspace("ws-default");
});

const json = (url: string, method: string, body?: unknown) =>
  new NextRequest(`http://test${url}`, {
    method,
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
const p = <T>(v: T) => ({ params: Promise.resolve(v) });

test("create, list, update and delete a bot", async () => {
  const created = await createBot(json("/api/bots", "POST", { name: "QA Bot", role: "tests signup" }));
  assert.equal(created.status, 201);
  const bot = await created.json();
  assert.equal(bot.idleMinutes, 30);

  const list = await (await listBots()).json();
  assert.equal(list.length, 1);
  assert.equal(list[0].activity, "off");

  const patched = await patchBot(
    json(`/api/bots/${bot.id}`, "PATCH", { instructions: "Use staging", idleMinutes: 10 }),
    p({ botId: bot.id }),
  );
  assert.equal((await patched.json()).idleMinutes, 10);

  // No container: delete must not need Docker.
  assert.equal((await deleteBot(json(`/api/bots/${bot.id}`, "DELETE"), p({ botId: bot.id }))).status, 200);
  assert.equal((await getBot(json(`/api/bots/${bot.id}`, "GET"), p({ botId: bot.id }))).status, 404);
});

test("invalid input is a 400, unknown bot a 404", async () => {
  assert.equal((await createBot(json("/api/bots", "POST", { name: "" }))).status, 400);
  assert.equal((await patchBot(json("/api/bots/x", "PATCH", { name: "y" }), p({ botId: "nope" }))).status, 404);
  assert.equal((await sendPrompt(json("/api/bots/x/runs", "POST", { prompt: "hi" }), p({ botId: "nope" }))).status, 404);
  assert.equal((await sendPrompt(json("/api/bots/x/runs", "POST", { prompt: "  " }), p({ botId: "nope" }))).status, 400);
});

test("the feed shows the latest session and the chat oldest-first; a queued prompt cancels", async () => {
  const bot = await prisma.bot.create({ data: { name: "Docs Bot" } });
  const old = await prisma.botSession.create({
    data: { botId: bot.id, status: "stopped", containerName: "c-old", createdAt: new Date(1000) },
  });
  const live = await prisma.botSession.create({
    data: {
      botId: bot.id,
      status: "ready",
      containerName: "c-live",
      vncPort: 49999,
      vncPassword: "pw",
      createdAt: new Date(2000),
    },
  });
  await prisma.botRun.create({
    data: { botId: bot.id, sessionId: old.id, prompt: "first", status: "completed", result: "ok", createdAt: new Date(1500) },
  });
  const queued = await prisma.botRun.create({
    data: { botId: bot.id, sessionId: live.id, prompt: "second", status: "queued", createdAt: new Date(2500), log: "secret log" },
  });

  const body = await (await feed(json(`/api/bots/${bot.id}/runs`, "GET"), p({ botId: bot.id }))).json();
  assert.equal(body.session.id, live.id);
  assert.match(body.session.vncUrl, /^http:\/\/127\.0\.0\.1:49999\/nexux-screen\.html\?/);
  assert.deepEqual(body.runs.map((r: { prompt: string }) => r.prompt), ["first", "second"]);
  assert.ok(!("log" in body.runs[1]));

  const list = await (await listBots()).json();
  assert.equal(list[0].activity, "working");

  const res = await cancelRun(json("/", "DELETE"), p({ botId: bot.id, runId: queued.id }));
  assert.equal(res.status, 200);
  assert.equal((await prisma.botRun.findUnique({ where: { id: queued.id } }))?.status, "canceled");
  // Already settled: nothing left to cancel.
  assert.equal((await cancelRun(json("/", "DELETE"), p({ botId: bot.id, runId: queued.id }))).status, 409);
});

test("isIdleExpired waits for pending work and the bot's idle window", () => {
  const now = 10 * 60_000;
  const s = { lastActivityAt: new Date(0) };
  assert.equal(isIdleExpired(s, 5, 0, now), true);
  assert.equal(isIdleExpired(s, 15, 0, now), false);
  assert.equal(isIdleExpired(s, 5, 1, now), false);
});

test("the reaper leaves busy and recent sessions alone", async () => {
  const bot = await prisma.bot.create({ data: { name: "Busy", idleMinutes: 5 } });
  const session = await prisma.botSession.create({
    data: { botId: bot.id, status: "ready", containerName: "c", lastActivityAt: new Date(0) },
  });
  await prisma.botRun.create({ data: { botId: bot.id, sessionId: session.id, prompt: "x", status: "queued" } });
  const recent = await prisma.bot.create({ data: { name: "Recent", idleMinutes: 5 } });
  await prisma.botSession.create({ data: { botId: recent.id, status: "ready", containerName: "c2" } });

  assert.equal(await reapIdleBots(), 0);
});

test("watching the screen keeps the computer awake (heartbeat)", async () => {
  const bot = await prisma.bot.create({ data: { name: "Watched", idleMinutes: 5 } });
  const session = await prisma.botSession.create({
    data: { botId: bot.id, status: "ready", containerName: "c3", lastActivityAt: new Date(0) },
  });
  const res = await touchSession(json(`/api/bots/${bot.id}/session`, "PATCH"), p({ botId: bot.id }));
  assert.equal(res.status, 200);
  const after = await prisma.botSession.findUniqueOrThrow({ where: { id: session.id } });
  assert.ok(Date.now() - after.lastActivityAt.getTime() < 5_000);
  assert.equal(await reapIdleBots(), 0); // touched: not idle any more

  await prisma.botSession.update({ where: { id: session.id }, data: { status: "stopped" } });
  const gone = await touchSession(json(`/api/bots/${bot.id}/session`, "PATCH"), p({ botId: bot.id }));
  assert.equal(gone.status, 404);
});

test("routines: create, pause, validate and delete by hand", async () => {
  const bot = await prisma.bot.create({ data: { name: "Gastos" } });
  const P = p({ botId: bot.id });
  const bad = await createRoutine(json("/r", "POST", { name: "X", prompt: "p", cron: "every monday" }), P);
  assert.equal(bad.status, 400);

  const res = await createRoutine(json("/r", "POST", { name: "Actualizar", prompt: "Revisa", cron: "0 8 * * 1" }), P);
  assert.equal(res.status, 201);
  const r = await res.json();
  assert.equal(r.label, "Every Monday around 8:00 AM");
  assert.ok(new Date(r.nextRunAt).getTime() > Date.now());

  const paused = await (await patchRoutine(json("/r", "PATCH", { enabled: false }), p({ botId: bot.id, routineId: r.id }))).json();
  assert.equal(paused.enabled, false);
  assert.equal(paused.nextRunAt, null);

  const other = await prisma.bot.create({ data: { name: "Other" } });
  const wrong = await deleteRoutine(json("/r", "DELETE"), p({ botId: other.id, routineId: r.id }));
  assert.equal(wrong.status, 404); // a routine is only reachable through its own bot
  assert.equal((await deleteRoutine(json("/r", "DELETE"), p({ botId: bot.id, routineId: r.id }))).status, 200);
  assert.deepEqual(await (await listRoutines(json("/r", "GET"), P)).json(), []);
});

test("the bot's routine blocks create, update by name, reject and delete", async () => {
  const bot = await prisma.bot.create({ data: { name: "Gastos" } });
  let changes = await applyRoutineSpecs(bot.id, [
    { name: "Actualizar gastos", cron: "0 8 * * 1", prompt: "Revisa Acme Books" },
    { name: "Sin horario", prompt: "p" },
    { name: "Cron malo", cron: "lunes", prompt: "p" },
  ]);
  assert.deepEqual(changes.map((c) => c.action), ["created", "rejected", "rejected"]);
  changes = await applyRoutineSpecs(bot.id, [{ name: "actualizar GASTOS", cron: "0 9 * * 1", enabled: false }]);
  assert.deepEqual(changes, [{ name: "Actualizar gastos", action: "updated" }]);
  const r = await prisma.botRoutine.findFirstOrThrow({ where: { botId: bot.id } });
  assert.equal(r.cron, "0 9 * * 1");
  assert.equal(r.prompt, "Revisa Acme Books"); // untouched fields stay
  assert.equal(r.nextRunAt, null); // paused
  changes = await applyRoutineSpecs(bot.id, [{ name: "Actualizar gastos", delete: true }]);
  assert.equal(changes[0]?.action, "deleted");
  assert.equal(await prisma.botRoutine.count({ where: { botId: bot.id } }), 0);
});

test("a due routine is rescheduled when the tick fires it", async () => {
  const bot = await prisma.bot.create({ data: { name: "Gastos" } });
  const past = new Date(Date.now() - 60_000);
  const r = await prisma.botRoutine.create({
    data: { botId: bot.id, name: "Due", prompt: "p", cron: "0 8 * * 1", nextRunAt: past },
  });
  const paused = await prisma.botRoutine.create({
    data: { botId: bot.id, name: "Paused", prompt: "p", cron: "0 8 * * 1", enabled: false, nextRunAt: past },
  });
  await fireDueRoutines(); // no Claude token in tests: queueing fails, the schedule still moves on
  const after = await prisma.botRoutine.findUniqueOrThrow({ where: { id: r.id } });
  assert.ok(after.nextRunAt && after.nextRunAt.getTime() > Date.now());
  assert.ok(after.lastRunAt);
  const untouched = await prisma.botRoutine.findUniqueOrThrow({ where: { id: paused.id } });
  assert.equal(untouched.lastRunAt, null);
});

test("a new bot can be created straight onto an endpoint", async () => {
  const ep = await prisma.dockerEndpoint.create({
    data: { name: "omarchy", host: "ssh://omarchy", updatedAt: new Date() },
  });
  const made = await createBot(
    json("/api/bots", "POST", { name: "Remote Hire", dockerEndpointId: ep.id }),
  );
  assert.equal(made.status, 201);
  assert.equal((await made.json()).dockerEndpointId, ep.id);

  // The default stays this machine when nothing is chosen.
  const local = await createBot(json("/api/bots", "POST", { name: "Local Hire" }));
  assert.equal((await local.json()).dockerEndpointId, null);

  // A dangling id is refused at creation too, not only on edit.
  const bad = await createBot(
    json("/api/bots", "POST", { name: "Nowhere", dockerEndpointId: "nope" }),
  );
  assert.equal(bad.status, 400);

  await prisma.bot.deleteMany({ where: { name: { in: ["Remote Hire", "Local Hire"] } } });
  await prisma.dockerEndpoint.delete({ where: { id: ep.id } });
});

test("a bot can be pointed at an endpoint, and never at one that is gone", async () => {
  const bot = await prisma.bot.create({ data: { name: "Pointable" } });
  const ep = await prisma.dockerEndpoint.create({
    data: { name: "litek8s", host: "unix:///Users/me/.litek8s/docker.sock", updatedAt: new Date() },
  });

  const ok = await patchBot(
    json(`/api/bots/${bot.id}`, "PATCH", { dockerEndpointId: ep.id }),
    p({ botId: bot.id }),
  );
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).dockerEndpointId, ep.id);

  // A dangling id is a 400 with a sentence, not a foreign-key 500.
  const bad = await patchBot(
    json(`/api/bots/${bot.id}`, "PATCH", { dockerEndpointId: "nope" }),
    p({ botId: bot.id }),
  );
  assert.equal(bad.status, 400);
  assert.match((await bad.json()).error, /no longer exists/);

  // And back to this machine.
  const home = await patchBot(
    json(`/api/bots/${bot.id}`, "PATCH", { dockerEndpointId: null }),
    p({ botId: bot.id }),
  );
  assert.equal((await home.json()).dockerEndpointId, null);

  await prisma.bot.delete({ where: { id: bot.id } });
  await prisma.dockerEndpoint.delete({ where: { id: ep.id } });
});

test("a restart adopts live ready computers and deletes the rest", () => {
  const plan = planRecovery(
    [
      { id: "a", status: "ready", containerName: "c-a", dockerHost: null }, // alive: adopted, sign-ins kept
      { id: "b", status: "ready", containerName: "c-b", dockerHost: null }, // container gone: ended
      { id: "c", status: "starting", containerName: "c-c", dockerHost: null }, // mid-boot: ended, container removed
    ],
    [
      { name: "c-a", dockerHost: null },
      { name: "c-c", dockerHost: null },
      { name: "c-orphan", dockerHost: null },
    ],
  );
  assert.deepEqual(plan, {
    adopt: ["a"],
    end: ["b", "c"],
    remove: [
      { name: "c-c", dockerHost: null },
      { name: "c-orphan", dockerHost: null },
    ],
  });
});

test("the same container name on two daemons is two computers, not one", () => {
  // A bot ran on an endpoint and was then pointed at this machine: the name is
  // derived from its id, so both daemons hold one. Matching on the name alone
  // would adopt the wrong computer and delete the live one.
  const plan = planRecovery(
    [{ id: "a", status: "ready", containerName: "c-a", dockerHost: null }],
    [
      { name: "c-a", dockerHost: null },
      { name: "c-a", dockerHost: "ssh://devbox" },
    ],
  );
  assert.deepEqual(plan.adopt, ["a"]);
  assert.deepEqual(plan.end, []);
  // Only the stale one, and on the daemon it is actually on.
  assert.deepEqual(plan.remove, [{ name: "c-a", dockerHost: "ssh://devbox" }]);
});

test("a bot's files are served sandboxed, and nothing outside its folder is", async () => {
  const dir = botFilesDir("bot1", "run1");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(`${dir}/slide 1.svg`, "<svg xmlns='http://www.w3.org/2000/svg'/>");
  const ok = await botFile(json("/f", "GET"), p({ botId: "bot1", runId: "run1", name: encodeURIComponent("slide 1.svg") }));
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get("content-type"), "image/svg+xml");
  assert.match(ok.headers.get("content-security-policy") ?? "", /sandbox/);
  for (const bad of [
    { botId: "bot1", runId: "run1", name: encodeURIComponent("../run1/slide 1.svg") },
    { botId: "bot1", runId: "..", name: "x" },
    { botId: "bot1", runId: "run1", name: "missing.png" },
  ]) {
    assert.equal((await botFile(json("/f", "GET"), p(bad))).status, 404, JSON.stringify(bad));
  }
});

test("handoffs go to named teammates only, and chains stop", async () => {
  const from = await prisma.bot.create({ data: { name: "Marketero" } });
  await prisma.bot.create({ data: { name: "Creative Designer" } });
  const msg = (to: string) => "ok\n```handoff\n" + JSON.stringify({ to, message: "haz el banner" }) + "\n```";
  // Unknown name: nothing queued. Over the hop limit: nothing queued.
  assert.equal(await deliverHandoffs({ fromId: from.id, fromName: "Marketero", hop: 1, text: msg("Nadie") }), 0);
  assert.equal(await deliverHandoffs({ fromId: from.id, fromName: "Marketero", hop: 99, text: msg("Creative Designer") }), 0);
  // A real teammate: queueing is attempted (it needs a Claude token to wake the computer, absent in tests).
  await assert.rejects(
    deliverHandoffs({ fromId: from.id, fromName: "Marketero", hop: 1, text: msg("creative designer") }),
    /Claude Code token/,
  );
});

test("email cards: discard once, reject bad addresses and unknown cards", async () => {
  const bot = await prisma.bot.create({ data: { name: "Mailer" } });
  const session = await prisma.botSession.create({ data: { botId: bot.id, status: "stopped", containerName: "c-mail" } });
  const mail = (to: string) => "```mail\n" + JSON.stringify({ to, subject: "Hola", body: "Cuerpo" }) + "\n```";
  const run = await prisma.botRun.create({
    data: { botId: bot.id, sessionId: session.id, prompt: "write them", status: "completed", result: `Listos.\n${mail("ana@example.com")}\n${mail("leo@example.com")}` },
  });
  const act = (body: unknown, runId = run.id) =>
    actOnMail(json(`/api/bots/${bot.id}/runs/${runId}/mail`, "POST", body), p({ botId: bot.id, runId }));

  assert.equal((await act({ index: 2, action: "discard" })).status, 404); // only two cards
  assert.equal((await act({ index: 0, action: "nope" })).status, 400);
  assert.equal((await act({ index: 0, action: "send", mail: { to: "not-an-address", subject: "x", body: "y" } })).status, 400);
  assert.equal((await act({ index: 0, action: "send", mail: { to: "a@b.co", cc: "bad", subject: "x", body: "y" } })).status, 400);

  assert.equal((await act({ index: 1, action: "discard" })).status, 200);
  assert.equal((await act({ index: 1, action: "discard" })).status, 409); // once per card
  const after = await prisma.botRun.findUniqueOrThrow({ where: { id: run.id } });
  assert.deepEqual(JSON.parse(after.mailState!), { "1": { status: "discarded" } });
  // Nothing was queued for a discard.
  assert.equal(await prisma.botRun.count({ where: { botId: bot.id } }), 1);
});

test("a bot's MCP servers: saved in the native shape, rejected when wrong, cleared with null", async () => {
  const created = await (await createBot(json("/api/bots?intro=0", "POST", { name: "Researcher" }))).json();
  const patch = (body: unknown) => patchBot(json(`/api/bots/${created.id}`, "PATCH", body), p({ botId: created.id }));
  const servers = { context7: { command: "npx", args: ["-y", "@upstash/context7-mcp"] } };

  const saved = await patch({ mcpServers: servers });
  assert.equal(saved.status, 200);
  assert.deepEqual((await saved.json()).mcpServers, servers);

  const bad = await patch({ mcpServers: { browser: { command: "x" } } });
  assert.equal(bad.status, 400);
  assert.match(JSON.stringify(await bad.json()), /is used by Nexus/);

  // Other edits leave them alone; null clears them.
  assert.deepEqual((await (await patch({ role: "reads docs" })).json()).mcpServers, servers);
  assert.equal((await (await patch({ mcpServers: null })).json()).mcpServers, null);
});

test("the inbox is one workspace's team, and a new bot is hired into it", async () => {
  const here = await (await createBot(json("/api/bots?intro=0", "POST", { name: "Here" }))).json();
  assert.equal(here.workspaceId, "ws-default");

  setActiveWorkspace(ALT_WORKSPACE);
  const there = await (await createBot(json("/api/bots?intro=0", "POST", { name: "There" }))).json();
  assert.equal(there.workspaceId, ALT_WORKSPACE);

  assert.deepEqual((await (await listBots()).json()).map((b: { name: string }) => b.name), ["There"]);
  setActiveWorkspace("ws-default");
  assert.deepEqual((await (await listBots()).json()).map((b: { name: string }) => b.name), ["Here"]);
});

test("a handoff never reaches a bot in another workspace", async () => {
  const sender = await prisma.bot.create({ data: { name: "Sender" } });
  await prisma.bot.create({ data: { name: "Mate" } });
  await prisma.bot.create({ data: { name: "Stranger", workspaceId: ALT_WORKSPACE } });
  const msg = (to: string) => "ok\n```handoff\n" + JSON.stringify({ to, message: "mira esto" }) + "\n```";

  // Another workspace's bot is not a teammate: the name resolves to nobody.
  assert.equal(await deliverHandoffs({ fromId: sender.id, fromName: "Sender", hop: 1, text: msg("Stranger") }), 0);
  // Its own workspace's: delivery is attempted (waking the computer needs a
  // Claude token, absent in tests — same signal the sibling test reads).
  await assert.rejects(
    deliverHandoffs({ fromId: sender.id, fromName: "Sender", hop: 1, text: msg("Mate") }),
    /Claude Code token/,
  );
});
