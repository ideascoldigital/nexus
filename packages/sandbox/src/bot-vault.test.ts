import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { botVaultMcpServer, renderVaultMcpScript, renderVaultTypeScript, BOT_VAULT_MCP_SCRIPT } from "./bot-vault";

test("the vault MCP server speaks MCP and only relays to Nexus, with its token", async () => {
  const seen: Array<{ method: string; url: string; token: string | undefined; body: string }> = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen.push({ method: req.method!, url: req.url!, token: req.headers["x-nexux-vault-token"] as string, body });
      res.setHeader("content-type", "application/json");
      if (req.url!.endsWith("/fill")) {
        const { field } = JSON.parse(body);
        if (field === "cvc") {
          res.statusCode = 403;
          res.end(JSON.stringify({ error: "Card details are only typed on https pages." }));
        } else res.end(JSON.stringify({ message: "Typed the password." }));
      } else res.end(JSON.stringify([{ name: "facebook.com", type: "login" }]));
    });
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const port = (server.address() as { port: number }).port;

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vault-mcp-"));
  const script = path.join(dir, "vault-mcp.js");
  fs.writeFileSync(script, renderVaultMcpScript());
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
  assert.equal((await waitFor(1)).result.protocolVersion, "2025-06-18");
  send({ jsonrpc: "2.0", method: "notifications/initialized" });
  send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  assert.deepEqual((await waitFor(2)).result.tools.map((t: { name: string }) => t.name), ["vault_list", "vault_fill"]);
  send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "vault_list", arguments: {} } });
  assert.match((await waitFor(3)).result.content[0].text, /facebook\.com/);
  send({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "vault_fill", arguments: { entry: "facebook.com", field: "password" } } });
  assert.equal((await waitFor(4)).result.content[0].text, "Typed the password.");
  send({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "vault_fill", arguments: { entry: "Visa", field: "cvc" } } });
  const refused = (await waitFor(5)).result;
  assert.equal(refused.isError, true);
  assert.match(refused.content[0].text, /https/);
  send({ jsonrpc: "2.0", id: 6, method: "nope" });
  assert.equal((await waitFor(6)).error.code, -32601);

  child.kill();
  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
  assert.deepEqual(
    seen.map((s) => [s.method, s.url, s.token]),
    [
      ["GET", "/api/bots/bot1/vault", "tok"],
      ["POST", "/api/bots/bot1/vault/fill", "tok"],
      ["POST", "/api/bots/bot1/vault/fill", "tok"],
    ],
  );
});

test("the MCP entry carries no secret, only where to ask and the run's token", () => {
  const entry = botVaultMcpServer({ nexusUrl: "http://host.docker.internal:3100", botId: "b", token: "t" });
  assert.deepEqual(entry.args, [BOT_VAULT_MCP_SCRIPT]);
  assert.deepEqual(Object.keys(entry.env).sort(), ["NEXUS_URL", "NEXUX_BOT_ID", "NEXUX_VAULT_TOKEN"]);
});

test("the typing script reads the value from stdin and checks the field before typing", () => {
  const s = renderVaultTypeScript();
  assert.match(s, /readFileSync\(0/);
  assert.match(s, /not a password field/);
  assert.match(s, /not one of the entry's websites/);
  assert.match(s, /only typed on https pages/);
  assert.doesNotMatch(s, /console\.log\(req\.text|process\.argv/);
});
