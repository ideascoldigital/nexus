import assert from "node:assert/strict";
import fs from "node:fs";
import { after, before, beforeEach, test } from "node:test";

// Env setup must stay above every other import: it points DATABASE_URL at a
// tmpdir and sets the active-workspace override the route modules read.
import { setActiveWorkspace, testDbDir } from "./workspace-routes.test-setup";
import { NextRequest } from "next/server";
import { prisma } from "@nexux/db";

import { GET as listAgents, POST as createAgent } from "./agents/route";
import { GET as listSkills } from "./skills/route";
import {
  DELETE as deleteSetting,
  GET as listSettings,
  POST as saveSetting,
} from "./settings/route";
import { GET as listWorkspaces } from "./workspaces/route";

const DEFAULT = "ws-default";
const ALT = "ws-alt";

before(async () => {
  // The default workspace is seeded by the migrations; add a second one.
  await prisma.workspace.upsert({
    where: { id: ALT },
    update: {},
    create: { id: ALT, name: "Alternate" },
  });
});

after(async () => {
  await prisma.$disconnect();
  fs.rmSync(testDbDir, { recursive: true, force: true });
});

beforeEach(async () => {
  await prisma.agent.deleteMany({});
  await prisma.skill.deleteMany({});
  await prisma.settings.deleteMany({});
  setActiveWorkspace(DEFAULT);
});

const post = (handler: (r: NextRequest) => Promise<Response>, body: unknown) =>
  handler(
    new NextRequest("http://test/api/r", {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
    })
  );

const json = async <T>(res: Response) => (await res.json()) as T;

type AgentRow = { name: string; workspaceId: string; inherited: boolean };
type SettingRow = { key: string; value: string; inherited: boolean };

// --- agents: workspace scoping ----------------------------------------------

test("an agent is created in the active workspace", async () => {
  setActiveWorkspace(ALT);
  const res = await post(createAgent, { name: "reviewer", systemPrompt: "sp" });
  assert.equal(res.status, 201);
  const stored = await prisma.agent.findUnique({ where: { name: "reviewer" } });
  assert.equal(stored?.workspaceId, ALT);
});

test("a workspace sees its own agents", async () => {
  setActiveWorkspace(ALT);
  await post(createAgent, { name: "mine", systemPrompt: "sp" });
  const agents = await json<AgentRow[]>(await listAgents());
  assert.deepEqual(
    agents.map((a) => a.name),
    ["mine"]
  );
  assert.equal(agents[0].inherited, false);
});

test("a workspace inherits the default workspace's agents", async () => {
  // Everything created before workspaces lives in the default one, so a new
  // workspace must still see it.
  await prisma.agent.create({
    data: { name: "shared", systemPrompt: "sp", workspaceId: DEFAULT },
  });
  setActiveWorkspace(ALT);
  const agents = await json<AgentRow[]>(await listAgents());
  assert.deepEqual(
    agents.map((a) => a.name),
    ["shared"]
  );
  assert.equal(agents[0].inherited, true, "an inherited agent is marked");
});

test("the default workspace does not see another workspace's agents", async () => {
  await prisma.agent.create({
    data: { name: "theirs", systemPrompt: "sp", workspaceId: ALT },
  });
  const agents = await json<AgentRow[]>(await listAgents());
  assert.deepEqual(agents, []);
});

test("an agent name cannot repeat across workspaces", async () => {
  // Agent.name is globally @unique, not unique per workspace — so the GET
  // handler's own-wins-on-clash dedup can never actually fire. Pinning the
  // real constraint here rather than the behaviour the handler expects.
  await prisma.agent.create({
    data: { name: "reviewer", systemPrompt: "default version", workspaceId: DEFAULT },
  });
  await assert.rejects(
    () =>
      prisma.agent.create({
        data: { name: "reviewer", systemPrompt: "alt version", workspaceId: ALT },
      }),
    /Unique constraint/
  );
});

test("a workspace cannot claim a name the default workspace already uses", async () => {
  // Consequence of the same constraint, through the route: the 409 fires on
  // an agent this workspace cannot even see.
  await prisma.agent.create({
    data: { name: "reviewer", systemPrompt: "sp", workspaceId: DEFAULT },
  });
  setActiveWorkspace(ALT);
  const res = await post(createAgent, { name: "reviewer", systemPrompt: "sp" });
  assert.equal(res.status, 409);
});

test("agent creation still validates its body", async () => {
  assert.equal((await post(createAgent, {})).status, 400);
  assert.equal((await post(createAgent, { name: "x" })).status, 400);
});

test("a duplicate agent name is refused", async () => {
  await post(createAgent, { name: "reviewer", systemPrompt: "sp" });
  const res = await post(createAgent, { name: "reviewer", systemPrompt: "sp" });
  assert.equal(res.status, 409);
});

// --- skills: same inheritance rules -----------------------------------------

test("skills follow the same own-plus-inherited rule", async () => {
  await prisma.skill.createMany({
    data: [
      { name: "deploy", workspaceId: DEFAULT },
      { name: "test", workspaceId: ALT },
    ],
  });
  setActiveWorkspace(ALT);
  const skills = await json<{ name: string }[]>(await listSkills());
  assert.deepEqual(
    skills.map((s) => s.name).sort(),
    ["deploy", "test"]
  );
});

test("the default workspace sees only its own skills", async () => {
  await prisma.skill.createMany({
    data: [
      { name: "deploy", workspaceId: DEFAULT },
      { name: "theirs", workspaceId: ALT },
    ],
  });
  const skills = await json<{ name: string }[]>(await listSkills());
  assert.deepEqual(
    skills.map((s) => s.name),
    ["deploy"]
  );
});

// --- settings: key prefixing and masking ------------------------------------

test("the default workspace stores settings under a bare key", async () => {
  // Anything configured before workspaces keeps working unchanged.
  const res = await post(saveSetting, { key: "openai_api_key", value: "sk-1234" });
  assert.equal(res.status, 200);
  const stored = await prisma.settings.findUnique({
    where: { key: "openai_api_key" },
  });
  assert.ok(stored, "the key is not prefixed for the default workspace");
});

test("a non-default workspace prefixes its setting keys", async () => {
  setActiveWorkspace(ALT);
  await post(saveSetting, { key: "openai_api_key", value: "sk-alt" });
  const stored = await prisma.settings.findUnique({
    where: { key: `ws:${ALT}:openai_api_key` },
  });
  assert.equal(stored?.value, "sk-alt");
  assert.equal(
    await prisma.settings.findUnique({ where: { key: "openai_api_key" } }),
    null,
    "the bare key is left alone"
  );
});

test("setting values are masked in the listing", async () => {
  // This endpoint is read by the browser; the secret must not leave the API.
  await post(saveSetting, { key: "openai_api_key", value: "sk-live-9999" });
  const settings = await json<SettingRow[]>(await listSettings());
  assert.equal(settings[0].value, "••••9999");
  assert.equal(JSON.stringify(settings).includes("sk-live"), false);
});

test("a short setting value leaks none of itself", async () => {
  await post(saveSetting, { key: "k", value: "abc" });
  const settings = await json<SettingRow[]>(await listSettings());
  assert.equal(settings[0].value, "••••");
});

test("a workspace's settings are listed under their bare name", async () => {
  // The prefix is storage detail — the client sees the key it sent.
  setActiveWorkspace(ALT);
  await post(saveSetting, { key: "openai_api_key", value: "sk-alt" });
  const settings = await json<SettingRow[]>(await listSettings());
  assert.deepEqual(
    settings.map((s) => s.key),
    ["openai_api_key"]
  );
  assert.equal(settings[0].inherited, false);
});

test("a workspace inherits the default workspace's settings", async () => {
  await post(saveSetting, { key: "openai_api_key", value: "sk-global" });
  setActiveWorkspace(ALT);
  const settings = await json<SettingRow[]>(await listSettings());
  assert.equal(settings.length, 1);
  assert.equal(settings[0].key, "openai_api_key");
  assert.equal(settings[0].inherited, true);
});

test("an own setting hides the inherited one with the same key", async () => {
  await post(saveSetting, { key: "openai_api_key", value: "sk-global" });
  setActiveWorkspace(ALT);
  await post(saveSetting, { key: "openai_api_key", value: "sk-alt" });
  const settings = await json<SettingRow[]>(await listSettings());
  assert.equal(settings.length, 1, "the key appears once");
  assert.equal(settings[0].inherited, false);
  assert.equal(settings[0].value, "••••-alt");
});

test("the default workspace never lists another workspace's settings", async () => {
  setActiveWorkspace(ALT);
  await post(saveSetting, { key: "secret", value: "alt-only" });
  setActiveWorkspace(DEFAULT);
  const settings = await json<SettingRow[]>(await listSettings());
  assert.deepEqual(settings, []);
});

test("saving the same key twice updates it in place", async () => {
  await post(saveSetting, { key: "k", value: "first" });
  await post(saveSetting, { key: "k", value: "second" });
  const rows = await prisma.settings.findMany({ where: { key: "k" } });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].value, "second");
});

test("a setting needs both a key and a value", async () => {
  assert.equal((await post(saveSetting, { key: "k" })).status, 400);
  assert.equal((await post(saveSetting, { value: "v" })).status, 400);
  assert.equal((await post(saveSetting, { key: "", value: "v" })).status, 400);
});

test("deleting a setting requires the key", async () => {
  const res = await deleteSetting(new NextRequest("http://test/api/settings"));
  assert.equal(res.status, 400);
});

test("a delete only removes the active workspace's copy", async () => {
  await post(saveSetting, { key: "shared", value: "global" });
  setActiveWorkspace(ALT);
  await post(saveSetting, { key: "shared", value: "alt" });

  const res = await deleteSetting(
    new NextRequest("http://test/api/settings?key=shared")
  );
  assert.equal(res.status, 200);
  assert.equal(
    await prisma.settings.findUnique({ where: { key: `ws:${ALT}:shared` } }),
    null
  );
  assert.ok(
    await prisma.settings.findUnique({ where: { key: "shared" } }),
    "the default workspace's copy survives"
  );
});

// --- workspaces list --------------------------------------------------------

test("the workspace list reports which one is active", async () => {
  setActiveWorkspace(ALT);
  const res = await listWorkspaces();
  assert.equal(res.status, 200);
  const payload = await json<{ activeId: string; workspaces: { id: string }[] }>(
    res
  );
  assert.equal(payload.activeId, ALT);
  assert.ok(payload.workspaces.some((w) => w.id === DEFAULT));
  assert.ok(payload.workspaces.some((w) => w.id === ALT));
});

test("an unknown active workspace falls back to the default", async () => {
  // A stale cookie must not strand the user in a workspace that is gone.
  setActiveWorkspace("ws-deleted");
  const payload = await json<{ activeId: string }>(await listWorkspaces());
  assert.equal(payload.activeId, DEFAULT);
});
