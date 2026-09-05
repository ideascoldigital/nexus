import assert from "node:assert/strict";
import { test } from "node:test";

// Env setup must stay above every other import — @nexux/db builds its client
// at module load against the throwaway SQLite file this configures.
import "../app/api/routes.test-setup";

import { prisma } from "@nexux/db";
import { findSetting } from "./workspace";

// findSetting is the one read every notification channel goes through; these
// pin the precedence that bit twice in production (Slack's first setup,
// Telegram's token rotation): the workspace's own value beats the bare key,
// the bare key beats foreign scopes, and a scoped-only value is still found.

test("a workspace's scoped value beats the bare key", async () => {
  await prisma.settings.create({
    data: { key: "probe_token", value: "bare" },
  });
  await prisma.settings.create({
    data: { key: "ws:wsA:probe_token", value: "scoped" },
  });
  assert.equal(await findSetting("probe_token", "wsA"), "scoped");
});

test("a workspace without its own value inherits the bare key", async () => {
  assert.equal(await findSetting("probe_token", "wsB"), "bare");
});

test("without a workspace the bare key wins over foreign scopes", async () => {
  assert.equal(await findSetting("probe_token"), "bare");
});

test("a value configured only inside a workspace is still found", async () => {
  await prisma.settings.updateMany({
    where: { key: "probe_token" },
    data: { isActive: false },
  });
  assert.equal(await findSetting("probe_token"), "scoped");
  assert.equal(await findSetting("probe_token", "wsB"), "scoped");
});

test("nothing configured resolves to null", async () => {
  assert.equal(await findSetting("probe_missing"), null);
});
