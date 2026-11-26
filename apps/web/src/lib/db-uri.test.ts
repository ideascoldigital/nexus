import assert from "node:assert/strict";
import { test } from "node:test";

import { normalizeDbUri } from "./db-uri";
import { resolveSecretRefs } from "./vault-items";

test("a raw password with @ : / # is encoded; the host and options stay", () => {
  assert.equal(
    normalizeDbUri("mongodb+srv://ro:p@ss:w/rd#1@cluster0.ab12c.mongodb.net/?retryWrites=true&w=majority"),
    "mongodb+srv://ro:p%40ss%3Aw%2Frd%231@cluster0.ab12c.mongodb.net/?retryWrites=true&w=majority",
  );
  assert.equal(normalizeDbUri("postgresql://app:a@b@db.local:5432/prod"), "postgresql://app:a%40b@db.local:5432/prod");
});

test("an already-encoded or plain string is left as it is", () => {
  const ok = "mongodb+srv://ro:p%40ss@cluster0.ab12c.mongodb.net/";
  assert.equal(normalizeDbUri(ok), ok);
  assert.equal(normalizeDbUri("mongodb://localhost:27017"), "mongodb://localhost:27017");
  assert.equal(normalizeDbUri("mongodb://user@host/db"), "mongodb://user@host/db");
  assert.equal(normalizeDbUri("mongodb+srv://ro:50%off@c.net/"), "mongodb+srv://ro:50%25off@c.net/");
  assert.equal(normalizeDbUri("https://a:b@c@example.com"), "https://a:b@c@example.com");
  assert.equal(normalizeDbUri("sk_live_123"), "sk_live_123");
});

test("a vault secret used in a bot's MCP server is encoded when it is a database URL", () => {
  const { servers } = resolveSecretRefs(
    { mongodb: { command: "npx", env: { MDB_MCP_CONNECTION_STRING: "{{secret:mongo}}", OTHER: "{{secret:token}}" } } },
    (n) => (n === "mongo" ? "mongodb+srv://ro:a@b@c.mongodb.net/" : "tok@en"),
  );
  assert.deepEqual((servers.mongodb as { env: Record<string, string> }).env, {
    MDB_MCP_CONNECTION_STRING: "mongodb+srv://ro:a%40b@c.mongodb.net/",
    OTHER: "tok@en",
  });
});
