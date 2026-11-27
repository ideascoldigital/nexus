import assert from "node:assert/strict";
import { test } from "node:test";

import "./routes.test-setup";
import { NextRequest } from "next/server";
import { prisma } from "@nexux/db";

import { GET, PATCH } from "./projects/[projectId]/notifications/route";

const p = (projectId: string) => ({ params: Promise.resolve({ projectId }) });
const patch = (body: unknown) =>
  new NextRequest("http://x/n", { method: "PATCH", body: JSON.stringify(body), headers: { "content-type": "application/json" } });

test("notifications save on their own, without resetting the rest of the sandbox setup", async () => {
  await prisma.workspace.upsert({ where: { id: "ws-default" }, update: {}, create: { id: "ws-default", name: "Mine" } });
  const project = await prisma.project.create({ data: { name: "N", workspaceId: "ws-default" } });
  await prisma.sandboxConfig.create({ data: { projectId: project.id, provider: "aws", region: "us-west-2" } });

  const res = await PATCH(patch({ telegramChatId: " -100123 " }), p(project.id));
  assert.deepEqual(await res.json(), { telegramChatId: "-100123", slackChannelId: null });
  await PATCH(patch({ slackChannelId: "#colony" }), p(project.id));
  assert.deepEqual(await (await GET(new NextRequest("http://x/n"), p(project.id))).json(), {
    telegramChatId: "-100123",
    slackChannelId: "#colony",
  });
  const config = await prisma.sandboxConfig.findUnique({ where: { projectId: project.id } });
  assert.equal(config?.provider, "aws");
  assert.equal(config?.region, "us-west-2");
  await PATCH(patch({ telegramChatId: "" }), p(project.id));
  assert.equal((await prisma.sandboxConfig.findUnique({ where: { projectId: project.id } }))?.telegramChatId, null);
});
