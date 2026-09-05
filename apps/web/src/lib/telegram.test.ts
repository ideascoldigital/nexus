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
