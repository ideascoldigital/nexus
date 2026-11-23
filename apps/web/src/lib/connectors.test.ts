import assert from "node:assert/strict";
import { test } from "node:test";

import { RESERVED_MCP_NAMES, validateBotMcpServers } from "./bot-mcp";
import { CONNECTORS, connectorById, connectorServers, publicValues, validateConnectorValues } from "./connectors";

test("the catalog: unique ids, valid MCP names, and every server is one a bot can load", () => {
  const ids = CONNECTORS.map((c) => c.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const c of CONNECTORS) {
    if (c.kind === "native") continue;
    assert.ok(!(RESERVED_MCP_NAMES as readonly string[]).includes(c.id), c.id);
    const sample = Object.fromEntries(c.fields.map((f) => [f.key, f.type === "toggle" ? "true" : (f.placeholder ?? "x")]));
    const server = c.server!(sample);
    assert.ok(validateBotMcpServers({ [c.id]: server }).ok, c.id);
  }
});

test("values: required fields, a sanity check on tokens, toggles default, a blank secret keeps the stored one", () => {
  const mongo = connectorById("mongodb")!;
  assert.deepEqual(validateConnectorValues(mongo, {}), { ok: false, error: "Connection string is required" });
  const bad = validateConnectorValues(mongo, { uri: "https://nope" });
  assert.equal(bad.ok, false);
  const good = validateConnectorValues(mongo, { uri: " mongodb+srv://u:p@c.x.net " });
  assert.deepEqual(good, { ok: true, values: { uri: "mongodb+srv://u:p@c.x.net", readOnly: "true" } });
  const edit = validateConnectorValues(mongo, { uri: "", readOnly: false }, { uri: "mongodb://old", readOnly: "true" });
  assert.deepEqual(edit, { ok: true, values: { uri: "mongodb://old", readOnly: "false" } });
  assert.equal(validateConnectorValues(mongo, { uri: "mongodb://a\nb" }).ok, false);
});

test("the browser never sees a secret, only that it is set", () => {
  const supa = connectorById("supabase")!;
  const shown = publicValues(supa, { token: "sbp_secret", projectRef: "abcdefghij", readOnly: "true" });
  assert.deepEqual(shown, { values: { projectRef: "abcdefghij", readOnly: "true" }, secretsSet: ["token"] });
  assert.ok(!JSON.stringify(shown).includes("sbp_secret"));
});

test("servers: read-only flags follow the toggle; broken rows and Gmail give none", () => {
  const servers = connectorServers([
    { id: "mongodb", values: { uri: "mongodb://x", readOnly: "true" } },
    { id: "github", values: { token: "github_pat_1", readOnly: "false" } },
    { id: "notion", values: {} },
    { id: "gmail", values: {} },
    { id: "unknown", values: { token: "x" } },
  ]);
  assert.deepEqual(Object.keys(servers), ["mongodb", "github"]);
  assert.deepEqual(servers.mongodb!.args, ["-y", "mongodb-mcp-server", "--readOnly"]);
  assert.deepEqual(servers.mongodb!.env, { MDB_MCP_CONNECTION_STRING: "mongodb://x" });
  assert.deepEqual(servers.github!.headers, { Authorization: "Bearer github_pat_1" });
});
