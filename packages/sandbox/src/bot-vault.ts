/**
 * The vault inside a bot's computer (spec 32). Two dependency-free Node
 * scripts, written in with each prompt (no image rebuild):
 *
 * - `vault-mcp.js` — an MCP stdio server with `vault_list` and `vault_fill`.
 *   It holds no secret: it asks Nexus, with a token valid only for the
 *   running prompt, and Nexus types the value itself.
 * - `vault-type.js` — types a value (read from stdin, never argv) into the
 *   focused field of the visible Chromium over CDP, after checking where that
 *   field is: a password only into <input type=password>, a login's fields only
 *   on its websites, a card's only over https.
 */

import { BOT_CDP_PORT, BOT_HOME, BOT_USER, dockerRun } from "./bot";
import { type DockerTarget } from "./docker-endpoint";

export const BOT_VAULT_MCP_SCRIPT = `${BOT_HOME}/.nexux-vault-mcp.js`;
export const BOT_VAULT_TYPE_SCRIPT = `${BOT_HOME}/.nexux-vault-type.js`;

/** The MCP server entry for the bot's config. The token rides in env (0600 file). */
export function botVaultMcpServer(opts: { nexusUrl: string; botId: string; token: string }) {
  return {
    command: "node",
    args: [BOT_VAULT_MCP_SCRIPT],
    env: { NEXUS_URL: opts.nexusUrl, NEXUX_BOT_ID: opts.botId, NEXUX_VAULT_TOKEN: opts.token },
  };
}

export function renderVaultMcpScript(): string {
  return `// Nexus vault MCP server (spec 32). Holds no secrets.
const base = (process.env.NEXUS_URL || "").replace(/\\/$/, "") + "/api/bots/" + process.env.NEXUX_BOT_ID + "/vault";
const headers = { "content-type": "application/json", "x-nexux-vault-token": process.env.NEXUX_VAULT_TOKEN || "" };
const tools = [
  {
    name: "vault_list",
    description: "List the vault entries you may use (logins, cards, contact details, secrets): names, websites, usernames and hints. Never the secret values.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "vault_fill",
    description: "Type a vault value into the field that is focused in your browser, without you seeing it. First click the field (password, card number…), then call this. A login's password only goes into a password field on one of its websites; card fields only on https pages.",
    inputSchema: {
      type: "object",
      properties: {
        entry: { type: "string", description: "The entry's name, as vault_list shows it (e.g. facebook.com, Visa •••• 4242)" },
        field: { type: "string", enum: ["password", "number", "expiry", "cvc", "holder", "email", "phone", "address"] },
      },
      required: ["entry", "field"],
      additionalProperties: false,
    },
  },
];
async function call(name, args) {
  const res = name === "vault_list"
    ? await fetch(base, { headers })
    : await fetch(base + "/fill", { method: "POST", headers, body: JSON.stringify(args || {}) });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) return { isError: true, content: [{ type: "text", text: body.error || ("vault: HTTP " + res.status) }] };
  return { content: [{ type: "text", text: name === "vault_list" ? JSON.stringify(body, null, 2) : (body.message || "Done.") }] };
}
let buf = "";
const send = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
process.stdin.setEncoding("utf8");
process.stdin.on("data", async (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.id === undefined) continue; // notifications
    try {
      if (msg.method === "initialize") {
        send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: (msg.params && msg.params.protocolVersion) || "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "nexus-vault", version: "1.0.0" } } });
      } else if (msg.method === "tools/list") {
        send({ jsonrpc: "2.0", id: msg.id, result: { tools } });
      } else if (msg.method === "tools/call") {
        send({ jsonrpc: "2.0", id: msg.id, result: await call(msg.params.name, msg.params.arguments) });
      } else if (msg.method === "ping") {
        send({ jsonrpc: "2.0", id: msg.id, result: {} });
      } else {
        send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "Method not found" } });
      }
    } catch (e) {
      send({ jsonrpc: "2.0", id: msg.id, result: { isError: true, content: [{ type: "text", text: "vault: " + (e && e.message || e) }] } });
    }
  }
});
`;
}

export function renderVaultTypeScript(): string {
  return `// Types a vault value into the focused field of the visible Chromium (spec 32).
// Input on stdin: { text, password, hosts, https }. The value is never printed.
const fs = require("fs");
const PROBE = "(() => { const a = document.activeElement; const ok = a && (a.isContentEditable || a.tagName === 'TEXTAREA' || (a.tagName === 'INPUT' && !['button','submit','checkbox','radio','file','hidden','image','reset','range','color'].includes((a.type || '').toLowerCase()))); return JSON.stringify({ focused: document.hasFocus(), editable: !!ok, type: a && a.tagName === 'INPUT' ? (a.type || 'text').toLowerCase() : (a ? a.tagName.toLowerCase() : ''), url: location.href }); })()";
const hostOk = (hosts, url) => { let h; try { h = new URL(url).hostname.toLowerCase().replace(/^www\\./, ""); } catch { return false; } return hosts.some((s) => h === s || h.endsWith("." + s)); };
(async () => {
  const req = JSON.parse(fs.readFileSync(0, "utf8"));
  const v = await (await fetch("http://127.0.0.1:${BOT_CDP_PORT}/json/version")).json();
  const ws = new WebSocket(v.webSocketDebuggerUrl);
  await new Promise((ok, fail) => { ws.onopen = ok; ws.onerror = fail; });
  let n = 0;
  const waiting = new Map();
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); } };
  const call = (method, params = {}, sessionId) => new Promise((ok) => { const id = ++n; waiting.set(id, ok); ws.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params })); });
  const targets = ((await call("Target.getTargets")).result.targetInfos || []).filter((t) => t.type === "page" && !t.url.startsWith("devtools:"));
  const found = [];
  for (const t of targets) {
    const s = (await call("Target.attachToTarget", { targetId: t.targetId, flatten: true })).result;
    if (!s) continue;
    const r = await call("Runtime.evaluate", { expression: PROBE, returnByValue: true }, s.sessionId);
    try { found.push({ sessionId: s.sessionId, ...JSON.parse(r.result.result.value) }); } catch {}
  }
  const pick = found.find((f) => f.focused && f.editable) || found.find((f) => f.editable);
  const out = (o) => { process.stdout.write(JSON.stringify(o)); ws.close(); process.exit(0); };
  if (!pick) return out({ ok: false, reason: "No field is focused in the browser. Click the field first." });
  let host = ""; try { host = new URL(pick.url).hostname; } catch {}
  if (req.password && pick.type !== "password") return out({ ok: false, reason: "The focused field is not a password field.", host });
  if (req.hosts && req.hosts.length && !hostOk(req.hosts, pick.url)) return out({ ok: false, reason: "This page (" + host + ") is not one of the entry's websites.", host });
  if (req.https && !pick.url.startsWith("https:")) return out({ ok: false, reason: "Card details are only typed on https pages.", host });
  const r = await call("Input.insertText", { text: req.text }, pick.sessionId);
  if (r.error) return out({ ok: false, reason: r.error.message, host });
  out({ ok: true, host });
})().catch((e) => { process.stdout.write(JSON.stringify({ ok: false, reason: String(e && e.message || e) })); process.exit(0); });
`;
}

/** Write the vault scripts into a computer (owner-only). */
export async function writeBotVaultScripts(
  name: string,
  target?: DockerTarget | null,
): Promise<void> {
  for (const [path, body] of [
    [BOT_VAULT_MCP_SCRIPT, renderVaultMcpScript()],
    [BOT_VAULT_TYPE_SCRIPT, renderVaultTypeScript()],
  ] as const) {
    const res = await dockerRun(target, ["exec", "-i", "-u", BOT_USER, name, "sh", "-c", `umask 077 && cat > ${path}`], { stdin: body, timeoutMs: 15_000 });
    if (res.code !== 0) throw new Error(`could not write the vault scripts: ${res.stderr.slice(-200)}`);
  }
}

export type VaultTypeResult = { ok: boolean; reason?: string; host?: string };

/** Type a value into the focused field of a bot's browser. The value travels on stdin only. */
export async function typeIntoBotBrowser(
  name: string,
  req: { text: string; password?: boolean; hosts?: string[]; https?: boolean },
  target?: DockerTarget | null,
): Promise<VaultTypeResult> {
  const res = await dockerRun(target, ["exec", "-i", "-u", BOT_USER, name, "node", BOT_VAULT_TYPE_SCRIPT], {
    stdin: JSON.stringify(req),
    timeoutMs: 20_000,
  });
  try {
    return JSON.parse(res.stdout) as VaultTypeResult;
  } catch {
    return { ok: false, reason: `could not reach the browser: ${res.stderr.slice(-200)}` };
  }
}
