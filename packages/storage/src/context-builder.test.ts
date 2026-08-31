import { strict as assert } from "node:assert";
import { afterEach, beforeEach, test } from "node:test";
import fs from "fs/promises";
import os from "os";
import path from "path";

import { ContextBuilder } from "./context-builder";

const PROJECT_ID = "abcdef12-3456-7890-abcd-ef1234567890";
const SLUG = PROJECT_ID.slice(0, 8);

let dataDir: string;
let workspace: string;
let savedDataDir: string | undefined;

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "nexux-data-"));
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), "nexux-ws-"));
  savedDataDir = process.env.NEXUX_DATA_DIR;
  process.env.NEXUX_DATA_DIR = dataDir;
});

afterEach(async () => {
  if (savedDataDir === undefined) delete process.env.NEXUX_DATA_DIR;
  else process.env.NEXUX_DATA_DIR = savedDataDir;
  await fs.rm(dataDir, { recursive: true, force: true });
  await fs.rm(workspace, { recursive: true, force: true });
});

function contextDir(): string {
  return path.join(dataDir, "projects", SLUG, ".claude");
}

test("ensureContextDir creates <dataDir>/projects/<slug>/.claude", async () => {
  const builder = new ContextBuilder(PROJECT_ID, workspace);
  const dir = await builder.ensureContextDir();
  assert.equal(dir, contextDir());
  const s = await fs.stat(dir);
  assert.ok(s.isDirectory());
});

test("writeConfig persists brain config as JSON", async () => {
  const builder = new ContextBuilder(PROJECT_ID, workspace);
  await builder.writeConfig({ provider: "ollama", model: "llama3" });
  const raw = await fs.readFile(path.join(contextDir(), "config.json"), "utf8");
  assert.deepEqual(JSON.parse(raw), { provider: "ollama", model: "llama3" });
});

test("writeSystemPrompt persists system.md", async () => {
  const builder = new ContextBuilder(PROJECT_ID, workspace);
  await builder.writeSystemPrompt("# hello");
  const raw = await fs.readFile(path.join(contextDir(), "system.md"), "utf8");
  assert.equal(raw, "# hello");
});

test("createSymlink links workspace/.claude to the context dir", async () => {
  const builder = new ContextBuilder(PROJECT_ID, workspace);
  await builder.ensureContextDir();
  await builder.createSymlink();
  const link = path.join(workspace, ".claude");
  const target = await fs.readlink(link);
  assert.equal(target, contextDir());
});

test("createSymlink replaces a stale symlink", async () => {
  const builder = new ContextBuilder(PROJECT_ID, workspace);
  await builder.ensureContextDir();
  const link = path.join(workspace, ".claude");
  await fs.symlink("/somewhere/stale", link);
  await builder.createSymlink();
  assert.equal(await fs.readlink(link), contextDir());
});

test("createSymlink leaves a real .claude directory untouched", async () => {
  const builder = new ContextBuilder(PROJECT_ID, workspace);
  await builder.ensureContextDir();
  const link = path.join(workspace, ".claude");
  await fs.mkdir(link);
  await fs.writeFile(path.join(link, "keep.txt"), "keep");
  await builder.createSymlink();
  const s = await fs.lstat(link);
  assert.ok(s.isDirectory());
  assert.ok(!s.isSymbolicLink());
  assert.equal(await fs.readFile(path.join(link, "keep.txt"), "utf8"), "keep");
});

test("buildInitialContext writes config, prompt, and symlink", async () => {
  const builder = new ContextBuilder(PROJECT_ID, workspace);
  await builder.buildInitialContext({ provider: "claude", model: "opus" });

  const cfg = JSON.parse(
    await fs.readFile(path.join(contextDir(), "config.json"), "utf8"),
  );
  assert.deepEqual(cfg, { provider: "claude", model: "opus" });

  const prompt = await fs.readFile(
    path.join(contextDir(), "system.md"),
    "utf8",
  );
  assert.match(prompt, /claude - opus/);

  const link = await fs.readlink(path.join(workspace, ".claude"));
  assert.equal(link, contextDir());
});
