import assert from "node:assert/strict";
import { test } from "node:test";

import { openCodeMcpServers } from "./mcp-config";

test("a stdio server becomes a local command with its args", () => {
  const { mcp, skipped } = openCodeMcpServers({
    fs: { command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "/opt/nexus"], env: { DEBUG: "1" } },
  });
  assert.deepEqual(mcp.fs, {
    type: "local",
    command: ["npx", "-y", "@modelcontextprotocol/server-filesystem", "/opt/nexus"],
    environment: { DEBUG: "1" },
    enabled: true,
  });
  assert.deepEqual(skipped, []);
});

test("http and sse servers become remote, headers kept", () => {
  const { mcp } = openCodeMcpServers({
    a: { type: "http", url: "https://mcp.example.com/mcp", headers: { Authorization: "Bearer x" } },
    b: { type: "sse", url: "https://mcp.example.com/sse" },
  });
  assert.deepEqual(mcp.a, {
    type: "remote",
    url: "https://mcp.example.com/mcp",
    headers: { Authorization: "Bearer x" },
    enabled: true,
  });
  assert.equal(mcp.b.type, "remote");
});

test("Claude's ${VAR} becomes OpenCode's {env:VAR}, defaults dropped", () => {
  const { mcp } = openCodeMcpServers({
    gh: { command: "gh-mcp", env: { GITHUB_TOKEN: "${GITHUB_TOKEN}", LEVEL: "${LEVEL:-info}" } },
    api: { url: "https://x/${TENANT}/mcp", headers: { Authorization: "Bearer ${API_KEY}" } },
  });
  assert.deepEqual(mcp.gh.type === "local" && mcp.gh.environment, {
    GITHUB_TOKEN: "{env:GITHUB_TOKEN}",
    LEVEL: "{env:LEVEL}",
  });
  assert.equal(mcp.api.type === "remote" && mcp.api.url, "https://x/{env:TENANT}/mcp");
  assert.equal(mcp.api.type === "remote" && mcp.api.headers?.Authorization, "Bearer {env:API_KEY}");
});

test("a server with neither command nor url is named, not dropped silently", () => {
  const { mcp, skipped } = openCodeMcpServers({ broken: { args: ["x"] }, junk: "nope" });
  assert.deepEqual(mcp, {});
  assert.deepEqual(skipped, ["broken", "junk"]);
});

test("nothing configured is nothing", () => {
  assert.deepEqual(openCodeMcpServers(null), { mcp: {}, skipped: [] });
});
