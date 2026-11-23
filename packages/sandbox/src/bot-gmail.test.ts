import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { BOT_GMAIL_MCP_SCRIPT, botGmailMcpServer, renderGmailMcpScript } from "./bot-gmail";

test("the Gmail MCP server relays each tool to Nexus with the run's token, holding no Google token", async () => {
  const seen: Array<{ method: string; url: string; token: string | undefined; body: Record<string, unknown> | null }> = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) : null;
      seen.push({ method: req.method!, url: req.url!, token: req.headers["x-nexux-vault-token"] as string, body });
      res.setHeader("content-type", "application/json");
      if (req.method === "GET") return res.end(JSON.stringify(["me@x.com"]));
      if (body.tool === "send" && body.to === "blocked@x.com") {
        res.statusCode = 403;
        return res.end(JSON.stringify({ error: "You can't use that account." }));
      }
      if (body.tool === "send") return res.end(JSON.stringify({ messageId: "m9", threadId: "t9", message: "Sent from me@x.com." }));
      res.end(JSON.stringify({ estimate: 1, messages: [{ id: "m1", subject: "Hola" }] }));
    });
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const port = (server.address() as { port: number }).port;

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gmail-mcp-"));
  const script = path.join(dir, "gmail-mcp.js");
  fs.writeFileSync(script, renderGmailMcpScript());
  const child = spawn(process.execPath, [script], {
    env: { ...process.env, NEXUS_URL: `http://127.0.0.1:${port}/`, NEXUX_BOT_ID: "bot1", NEXUX_VAULT_TOKEN: "tok" },
  });
  const replies: Array<Record<string, any>> = [];
  let buf = "";
  child.stdout.on("data", (c) => {
    buf += c;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      replies.push(JSON.parse(buf.slice(0, i)));
      buf = buf.slice(i + 1);
    }
  });
  const send = (m: unknown) => child.stdin.write(JSON.stringify(m) + "\n");
  const waitFor = async (id: number) => {
    for (let t = 0; t < 200; t++) {
      const r = replies.find((x) => x.id === id);
      if (r) return r;
      await new Promise((ok) => setTimeout(ok, 10));
    }
    throw new Error(`no reply ${id}`);
  };

  send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } });
  assert.equal((await waitFor(1)).result.serverInfo.name, "nexus-gmail");
  send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  assert.deepEqual(
    (await waitFor(2)).result.tools.map((t: { name: string }) => t.name),
    ["gmail_accounts", "gmail_search", "gmail_read", "gmail_draft", "gmail_send"],
  );
  send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "gmail_accounts", arguments: {} } });
  assert.match((await waitFor(3)).result.content[0].text, /me@x\.com/);
  send({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "gmail_search", arguments: { query: "is:unread" } } });
  assert.match((await waitFor(4)).result.content[0].text, /"subject": "Hola"/);
  send({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "gmail_send", arguments: { to: "ana@x.com", subject: "s", body: "b" } } });
  assert.equal((await waitFor(5)).result.content[0].text, "Sent from me@x.com.");
  send({ jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "gmail_send", arguments: { to: "blocked@x.com" } } });
  const refused = (await waitFor(6)).result;
  assert.equal(refused.isError, true);
  assert.match(refused.content[0].text, /can't use/);

  child.kill();
  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
  assert.ok(seen.every((s) => s.token === "tok" && s.url === "/api/bots/bot1/gmail"));
  assert.deepEqual(seen.map((s) => s.body?.tool ?? s.method), ["GET", "search", "send", "send"]);
});

test("the MCP entry carries no Google token, only where to ask and the run's token", () => {
  const entry = botGmailMcpServer({ nexusUrl: "http://host.docker.internal:3100", botId: "b", token: "t" });
  assert.deepEqual(entry.args, [BOT_GMAIL_MCP_SCRIPT]);
  assert.deepEqual(Object.keys(entry.env).sort(), ["NEXUS_URL", "NEXUX_BOT_ID", "NEXUX_VAULT_TOKEN"]);
});
