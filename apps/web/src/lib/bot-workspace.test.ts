import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

// getConfig() reads NEXUX_DATA_DIR on each call, so pointing it here is enough.
process.env.NEXUX_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "nexux-ws-"));

import { botMounts, botWorkdir, removeBotProfile, workspaceFolderFor, workspaceRoot } from "./bot-workspace";

test("each bot's folder is a stable slug of its name", () => {
  assert.equal(workspaceFolderFor("Creative Designer"), "creative-designer");
  assert.equal(workspaceFolderFor("Acme Support customer experience"), "acme-support-customer-experience");
  assert.equal(workspaceFolderFor("Gastos ñandú — Acme!"), "gastos-nandu-acme");
  assert.equal(workspaceFolderFor("🤖"), "bot");
  assert.equal(botWorkdir("Maya"), "/workspace/maya");
});

test("mounts: the shared workspace and the bot's own profile, created on the host", () => {
  const mounts = botMounts({ id: "bot_1", name: "Gastos" });
  assert.deepEqual(
    mounts.map((m) => m.container),
    ["/workspace", "/home/bot/.chrome"],
  );
  assert.equal(mounts[0]!.host, workspaceRoot());
  assert.ok(fs.statSync(path.join(workspaceRoot(), "gastos")).isDirectory());
  assert.ok(fs.statSync(mounts[1]!.host).isDirectory());
  // Deleting the bot drops its sign-ins but keeps the shared work.
  removeBotProfile("bot_1");
  assert.ok(!fs.existsSync(mounts[1]!.host));
  assert.ok(fs.existsSync(path.join(workspaceRoot(), "gastos")));
});
