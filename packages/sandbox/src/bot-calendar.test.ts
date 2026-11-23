import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { BOT_CALENDAR_MCP_SCRIPT, botCalendarMcpServer, renderCalendarMcpScript } from "./bot-calendar";

test("the Calendar MCP server relays each tool to Nexus with the run's token, holding no Google token", async () => {
  const seen: Array<{ method: string; url: string; token: string | undefined; body: Record<string, unknown> | null }> = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) : null;
      seen.push({ method: req.method!, url: req.url!, token: req.headers["x-nexux-vault-token"] as string, body });
      res.setHeader("content-type", "application/json");
      if (req.method === "GET") return res.end(JSON.stringify(["me@x.com"]));
      if (body.tool === "create_event" && !body.end) {
        res.statusCode = 400;
        return res.end(JSON.stringify({ error: "calendar: the event needs an end" }));
      }
      if (body.tool === "delete_event") return res.end(JSON.stringify({ message: "Deleted from me@x.com's calendar." }));
      if (body.tool === "create_event") return res.end(JSON.stringify({ id: "e9", summary: body.summary }));
      res.end(JSON.stringify({ events: [{ id: "e1", summary: "Standup" }] }));
    });
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const port = (server.address() as { port: number }).port;

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "calendar-mcp-"));
  const script = path.join(dir, "calendar-mcp.js");
  fs.writeFileSync(script, renderCalendarMcpScript());
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
  const callTool = (id: number, name: string, args: Record<string, unknown>) =>
    send({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });

  send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } });
  assert.equal((await waitFor(1)).result.serverInfo.name, "nexus-calendar");
  send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  const tools = (await waitFor(2)).result.tools as Array<{ name: string; inputSchema: { properties: Record<string, unknown> } }>;
  assert.deepEqual(tools.map((t) => t.name), [
    "calendar_accounts",
    "calendar_calendars",
    "calendar_events",
    "calendar_get_event",
    "calendar_freebusy",
    "calendar_create_event",
    "calendar_update_event",
    "calendar_delete_event",
  ]);
  assert.ok("notify" in tools.find((t) => t.name === "calendar_create_event")!.inputSchema.properties);

  callTool(3, "calendar_accounts", {});
  assert.match((await waitFor(3)).result.content[0].text, /me@x\.com/);
  callTool(4, "calendar_events", { timeMin: "2026-11-24T00:00:00-05:00", timeMax: "2026-11-25T00:00:00-05:00" });
  assert.match((await waitFor(4)).result.content[0].text, /"summary": "Standup"/);
  callTool(5, "calendar_create_event", { summary: "Demo", start: "2026-11-24T10:00", end: "2026-11-24T10:30" });
  assert.match((await waitFor(5)).result.content[0].text, /"id": "e9"/);
  callTool(6, "calendar_create_event", { summary: "Demo", start: "2026-11-24T10:00" });
  const refused = (await waitFor(6)).result;
  assert.equal(refused.isError, true);
  assert.match(refused.content[0].text, /needs an end/);
  callTool(7, "calendar_delete_event", { eventId: "e1" });
  assert.equal((await waitFor(7)).result.content[0].text, "Deleted from me@x.com's calendar.");

  child.kill();
  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
  assert.ok(seen.every((s) => s.token === "tok" && s.url === "/api/bots/bot1/calendar"));
  assert.deepEqual(seen.map((s) => s.body?.tool ?? s.method), ["GET", "events", "create_event", "create_event", "delete_event"]);
});

test("the MCP entry carries no Google token, only where to ask and the run's token", () => {
  const entry = botCalendarMcpServer({ nexusUrl: "http://host.docker.internal:3100", botId: "b", token: "t" });
  assert.deepEqual(entry.args, [BOT_CALENDAR_MCP_SCRIPT]);
  assert.deepEqual(Object.keys(entry.env).sort(), ["NEXUS_URL", "NEXUX_BOT_ID", "NEXUX_VAULT_TOKEN"]);
});
