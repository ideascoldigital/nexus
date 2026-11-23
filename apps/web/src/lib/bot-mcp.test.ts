import assert from "node:assert/strict";
import test from "node:test";

import { mcpServerNames, parseBotMcpJson, validateBotMcpServers } from "./bot-mcp";

const ok = (v: ReturnType<typeof validateBotMcpServers>) => (v.ok ? v.servers : `ERR ${v.error}`);

test("stdio and remote servers in the native shape pass", () => {
  const servers = {
    context7: { command: "npx", args: ["-y", "@upstash/context7-mcp"], env: { KEY: "x" } },
    "my-api": { type: "http", url: "https://mcp.example.com/mcp", headers: { Authorization: "Bearer t" } },
    events: { type: "sse", url: "http://host.docker.internal:9000/sse" },
  };
  assert.deepEqual(ok(validateBotMcpServers(servers)), servers);
  assert.deepEqual(mcpServerNames(servers), ["context7", "my-api", "events"]);
});

test("empty means none", () => {
  assert.equal(ok(validateBotMcpServers(null)), null);
  assert.equal(ok(validateBotMcpServers({})), null);
  assert.equal(ok(parseBotMcpJson("   ")), null);
  assert.deepEqual(mcpServerNames(null), []);
});

test("each problem is named, for the user", () => {
  const err = (v: unknown) => {
    const r = validateBotMcpServers(v);
    return r.ok ? "" : r.error;
  };
  assert.match(err([]), /Expected/);
  assert.match(err({ browser: { command: "x" } }), /is used by Nexus/);
  assert.match(err({ vault: { command: "x" } }), /is used by Nexus/);
  assert.match(err({ gmail: { command: "x" } }), /is used by Nexus/);
  assert.match(err({ "bad name": { command: "x" } }), /names are letters/);
  assert.match(err({ a: { args: ["x"] } }), /needs a command/);
  assert.match(err({ a: { type: "http" } }), /needs a url/);
  assert.match(err({ a: { type: "ws", url: "https://x" } }), /type is stdio, http or sse/);
  assert.match(err({ a: { command: "x", args: "nope" } }), /args must be a list/);
  assert.match(err({ a: { command: "x", env: { N: 1 } } }), /env must be text/);
  assert.match(err({ a: { type: "http", url: "https://x", headers: { H: 2 } } }), /headers must be text/);
});

test("the textarea takes the servers, or a whole config with mcpServers", () => {
  const inner = { ctx: { command: "npx", args: ["-y", "ctx"] } };
  assert.deepEqual(ok(parseBotMcpJson(JSON.stringify(inner))), inner);
  assert.deepEqual(ok(parseBotMcpJson(JSON.stringify({ mcpServers: inner }))), inner);
  const bad = parseBotMcpJson("{ nope");
  assert.equal(bad.ok, false);
});
