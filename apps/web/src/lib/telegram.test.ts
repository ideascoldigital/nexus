import assert from "node:assert/strict";
import { test } from "node:test";

// Env setup must stay above every other import — @nexux/db builds its client
// at module load against the throwaway SQLite file this configures.
import "../app/api/routes.test-setup";

import { prisma } from "@nexux/db";
import { isTelegramConfigured } from "./telegram";

// Network paths (sendMessage, getUpdates) are exercised against the real Bot
// API by hand; covered here: the settings resolution that gates every send.
// The regression this pins: a token rotated from inside a workspace lands
// under ws:<id>:telegram_bot_token, and the old bare-key read kept sending
// (and polling) with the revoked global token — silent 401s everywhere.

test("unconfigured install reports telegram off", async () => {
  await prisma.settings.updateMany({
    where: { key: { in: ["telegram_bot_token", "telegram_chat_id"] } },
    data: { isActive: false },
  });
  assert.equal(await isTelegramConfigured(), false);
});

test("a token and chat saved from a non-default workspace count", async () => {
  await prisma.settings.create({
    data: { key: "ws:cmr123abc:telegram_bot_token", value: "12345:scoped" },
  });
  await prisma.settings.create({
    data: { key: "ws:cmr123abc:telegram_chat_id", value: "-100123" },
  });
  assert.equal(await isTelegramConfigured(), true, "scoped keys must count");
});

test("buildChatRoutes unions the projects sharing one chat", async () => {
  const { buildChatRoutes } = await import("./telegram");
  // The topology that broke it live: three group chats, each carrying several
  // projects, plus a global chat.
  const routes = buildChatRoutes(
    [
      { chatId: "-100A", projectId: "konstruct" },
      { chatId: "-100A", projectId: "konstruct-ui" },
      { chatId: "-100B", projectId: "landing" },
      { chatId: "-100C", projectId: "admin" },
      { chatId: "-100C", projectId: "risk" },
      { chatId: "-100C", projectId: "landing2" },
      { chatId: "  ", projectId: "ignored" },
      { chatId: null, projectId: "ignored-too" },
    ],
    "G1",
  );
  assert.deepEqual([...(routes.get("-100A") ?? [])].sort(), [
    "konstruct",
    "konstruct-ui",
  ]);
  assert.deepEqual([...(routes.get("-100B") ?? [])], ["landing"]);
  assert.equal(routes.get("-100C")?.size, 3);
  assert.equal(routes.get("G1"), null, "the global chat scopes to everything");
  assert.equal(routes.size, 4, "blank/null chat ids never route");
});

test("the global chat wins over a project reusing the same id", async () => {
  const { buildChatRoutes } = await import("./telegram");
  const routes = buildChatRoutes(
    [{ chatId: "G1", projectId: "p1" }],
    "G1",
  );
  assert.equal(routes.get("G1"), null);
});
