import assert from "node:assert/strict";
import { test } from "node:test";

// Env setup must stay above every other import — @nexux/db builds its client
// at module load against the throwaway SQLite file this configures.
import "../app/api/routes.test-setup";

import { prisma } from "@nexux/db";
import {
  OLLAMA_URL_SETTING,
  ollamaHostForProject,
  ollamaHostForWorkspace,
  ollamaHostFrom,
} from "./ollama-host";
import { DEFAULT_WORKSPACE_ID } from "./workspace";

// The bug this pins: an "Ollama URL" saved in Settings never reached the
// embedder, which read only OLLAMA_URL. The saved value must win, per
// workspace, and the environment must still answer when nothing is saved.

process.env.OLLAMA_URL = "http://env-ollama:11434";

test("the setting is read under the ollama_url key", async () => {
  const asked: string[] = [];
  const resolved = await ollamaHostFrom(async (key) => {
    asked.push(key);
    return "http://gpu-box:11434";
  });
  assert.deepEqual(asked, [OLLAMA_URL_SETTING]);
  assert.deepEqual(resolved, { host: "http://gpu-box:11434", source: "setting" });
});

test("nothing saved falls back to OLLAMA_URL", async () => {
  assert.deepEqual(await ollamaHostFrom(async () => null), {
    host: "http://env-ollama:11434",
    source: "env",
  });
});

test("a workspace with nothing saved uses the environment", async () => {
  assert.equal((await ollamaHostForWorkspace(DEFAULT_WORKSPACE_ID)).source, "env");
});

test("a URL saved in the default workspace is used", async () => {
  await prisma.settings.create({
    data: { key: OLLAMA_URL_SETTING, value: "http://saved-default:11434" },
  });
  assert.deepEqual(await ollamaHostForWorkspace(DEFAULT_WORKSPACE_ID), {
    host: "http://saved-default:11434",
    source: "setting",
  });
});

test("another workspace inherits the default workspace's URL", async () => {
  assert.equal(
    (await ollamaHostForWorkspace("ws-other")).host,
    "http://saved-default:11434",
  );
});

test("a workspace's own URL beats the inherited one", async () => {
  await prisma.settings.create({
    data: { key: `ws:ws-own:${OLLAMA_URL_SETTING}`, value: "http://saved-own:11434" },
  });
  assert.equal((await ollamaHostForWorkspace("ws-own")).host, "http://saved-own:11434");
});

test("a deactivated setting is ignored", async () => {
  await prisma.settings.updateMany({
    where: { key: OLLAMA_URL_SETTING },
    data: { isActive: false },
  });
  assert.equal((await ollamaHostForWorkspace(DEFAULT_WORKSPACE_ID)).source, "env");
  await prisma.settings.updateMany({
    where: { key: OLLAMA_URL_SETTING },
    data: { isActive: true },
  });
});

test("a project resolves through its workspace", async () => {
  await prisma.workspace.create({ data: { id: "ws-own", name: "Own" } });
  const project = await prisma.project.create({
    data: { name: "p", workspaceId: "ws-own" },
  });
  assert.equal((await ollamaHostForProject(project.id)).host, "http://saved-own:11434");
});

test("an unknown project resolves through the default workspace", async () => {
  assert.equal(
    (await ollamaHostForProject("no-such-project")).host,
    "http://saved-default:11434",
  );
});
