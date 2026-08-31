import { strict as assert } from "node:assert";
import { afterEach, beforeEach, test } from "node:test";
import os from "os";
import path from "path";

import { getConfig } from "./env";

const VARS = [
  "NEXUX_DATA_DIR",
  "DATABASE_URL",
  "ENCRYPTION_KEY",
  "OLLAMA_URL",
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "OPENAPI_KEY",
  "CODEX_API_URL",
  "AGENTS_GENERATOR_API_URL",
];

let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = Object.fromEntries(VARS.map((v) => [v, process.env[v]]));
  for (const v of VARS) delete process.env[v];
});

afterEach(() => {
  for (const v of VARS) {
    if (saved[v] === undefined) delete process.env[v];
    else process.env[v] = saved[v];
  }
});

test("dataDir defaults to ~/.nexux and honors NEXUX_DATA_DIR", () => {
  const home = process.env.HOME ?? os.homedir();
  assert.equal(getConfig().dataDir, path.join(home, ".nexux"));

  process.env.NEXUX_DATA_DIR = "/custom/data";
  assert.equal(getConfig().dataDir, "/custom/data");
});

test("databaseUrl throws when DATABASE_URL is missing", () => {
  assert.throws(() => getConfig().databaseUrl, /DATABASE_URL/);

  process.env.DATABASE_URL = "file:./test.db";
  assert.equal(getConfig().databaseUrl, "file:./test.db");
});

test("encryptionKey is optional", () => {
  assert.equal(getConfig().encryptionKey, undefined);

  process.env.ENCRYPTION_KEY = "secret";
  assert.equal(getConfig().encryptionKey, "secret");
});

test("llm config defaults and overrides", () => {
  const llm = getConfig().llm;
  assert.equal(llm.ollamaUrl, "http://localhost:11434");
  assert.equal(llm.anthropicApiKey, undefined);
  assert.equal(llm.openaiApiKey, undefined);

  process.env.OLLAMA_URL = "http://ollama:11434";
  process.env.ANTHROPIC_API_KEY = "ak";
  process.env.OPENAI_API_KEY = "ok";
  const llm2 = getConfig().llm;
  assert.equal(llm2.ollamaUrl, "http://ollama:11434");
  assert.equal(llm2.anthropicApiKey, "ak");
  assert.equal(llm2.openaiApiKey, "ok");
});

test("openaiApiKey falls back to legacy OPENAPI_KEY", () => {
  process.env.OPENAPI_KEY = "legacy";
  assert.equal(getConfig().llm.openaiApiKey, "legacy");

  process.env.OPENAI_API_KEY = "modern";
  assert.equal(getConfig().llm.openaiApiKey, "modern");
});

test("integrations defaults and overrides", () => {
  const i = getConfig().integrations;
  assert.equal(i.codexApiUrl, "https://api.codex.com/v1");
  assert.equal(i.agentsGeneratorApiUrl, "https://api.agentsgenerator.dev");

  process.env.CODEX_API_URL = "http://localhost:9999";
  assert.equal(getConfig().integrations.codexApiUrl, "http://localhost:9999");
});

test("lazy getters: missing DATABASE_URL does not break unrelated slices", () => {
  assert.equal(typeof getConfig().dataDir, "string");
  assert.equal(typeof getConfig().llm.ollamaUrl, "string");
});

test("mode is local unless NEXUX_MODE=server", () => {
  // MODE is captured at module load; in the test env it must be "local".
  assert.equal(getConfig().mode, "local");
});
