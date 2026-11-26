import assert from "node:assert/strict";
import fs from "node:fs";
import { after, test } from "node:test";

// Env setup must stay above every other import (throwaway DB and data dir).
import { testDbDir } from "./routes.test-setup";
import { NextRequest } from "next/server";
import { prisma } from "@nexux/db";

import { GET, PUT } from "./bots/[botId]/skills/route";
import { botSkillFiles } from "@/services/bot-skill-store";

after(async () => {
  await prisma.$disconnect();
  fs.rmSync(testDbDir, { recursive: true, force: true });
});

const params = (botId: string) => ({ params: Promise.resolve({ botId }) });
const put = (botId: string, skillIds: unknown) =>
  PUT(new NextRequest("http://localhost/x", { method: "PUT", body: JSON.stringify({ skillIds }) }), params(botId));

test("a bot loads skills from its library, and they come out as files", async () => {
  const bot = await prisma.bot.create({ data: { name: "Sofi" } });
  const a = await prisma.skill.create({ data: { name: "bs-alpha", description: "A", body: "Alpha body" } });
  const b = await prisma.skill.create({ data: { name: "bs-beta" } });

  const first = (await (await GET(new NextRequest("http://localhost/x"), params(bot.id))).json()) as {
    skills: { id: string; loaded: boolean }[];
  };
  assert.ok(first.skills.some((s) => s.id === a.id && !s.loaded));

  const res = await put(bot.id, [a.id, b.id, a.id]);
  assert.equal(res.status, 200);
  const loaded = ((await res.json()) as { skills: { id: string; loaded: boolean }[] }).skills.filter((s) => s.loaded);
  assert.deepEqual(loaded.map((s) => s.id).sort(), [a.id, b.id].sort());

  await put(bot.id, [b.id]);
  const files = await botSkillFiles(bot.id);
  assert.deepEqual(files.map((f) => f.name), ["bs-beta"]);
  assert.equal(files[0].files[0].path, "SKILL.md");
});

test("skills: an unknown skill, a bad body or an unknown bot are refused", async () => {
  const bot = await prisma.bot.create({ data: { name: "Tato" } });
  assert.equal((await put(bot.id, ["nope"])).status, 400);
  assert.equal((await put(bot.id, "x")).status, 400);
  assert.equal((await put("nope", [])).status, 404);
  assert.equal((await GET(new NextRequest("http://localhost/x"), params("nope"))).status, 404);
});

test("a skill from another workspace is not in the library", async () => {
  await prisma.workspace.upsert({ where: { id: "ws-other" }, create: { id: "ws-other", name: "Other" }, update: {} });
  const bot = await prisma.bot.create({ data: { name: "Uma" } });
  const foreign = await prisma.skill.create({ data: { name: "bs-foreign", workspaceId: "ws-other" } });
  assert.equal((await put(bot.id, [foreign.id])).status, 400);
});
