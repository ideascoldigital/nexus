/**
 * Gmail inside a bot's computer (spec 34): a dependency-free MCP stdio server,
 * written in with each prompt like the vault's. It holds no Google token —
 * only the running prompt's token — and relays every call to Nexus, which
 * talks to Gmail with the account's own token.
 */

import { BOT_HOME, BOT_USER, dockerRun } from "./bot";
import { type DockerTarget } from "./docker-endpoint";

export const BOT_GMAIL_MCP_SCRIPT = `${BOT_HOME}/.nexux-gmail-mcp.js`;

/** The MCP server entry for the bot's config. The token rides in env (0600 file). */
export function botGmailMcpServer(opts: { nexusUrl: string; botId: string; token: string }) {
  return {
    command: "node",
    args: [BOT_GMAIL_MCP_SCRIPT],
    env: { NEXUS_URL: opts.nexusUrl, NEXUX_BOT_ID: opts.botId, NEXUX_VAULT_TOKEN: opts.token },
  };
}

export function renderGmailMcpScript(): string {
  return `// Nexus Gmail MCP server (spec 34). Holds no Google token.
const base = (process.env.NEXUS_URL || "").replace(/\\/$/, "") + "/api/bots/" + process.env.NEXUX_BOT_ID + "/gmail";
const headers = { "content-type": "application/json", "x-nexux-vault-token": process.env.NEXUX_VAULT_TOKEN || "" };
const account = { type: "string", description: "Which connected address to use. Leave it out when you have only one." };
const mail = {
  account,
  to: { type: "string", description: "Comma-separated addresses" },
  cc: { type: "string" },
  bcc: { type: "string" },
  subject: { type: "string" },
  body: { type: "string", description: "Plain text with \\\\n line breaks, greeting and signature included" },
  threadId: { type: "string", description: "To reply inside an existing conversation (from gmail_search or gmail_read)" },
};
const tools = [
  {
    name: "gmail_accounts",
    description: "The Gmail addresses you can use.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "gmail_search",
    description: "Search the mailbox with Gmail's own syntax (from:ana@x.com, to:, subject:, is:unread, newer_than:7d, in:sent, has:attachment…). Returns sender, subject, date, snippet and the ids to read.",
    inputSchema: { type: "object", properties: { account, query: { type: "string" }, max: { type: "number", description: "1–25, default 10" } }, required: ["query"], additionalProperties: false },
  },
  {
    name: "gmail_read",
    description: "Read a whole conversation (threadId) or one message (messageId), with the text of each email.",
    inputSchema: { type: "object", properties: { account, threadId: { type: "string" }, messageId: { type: "string" } }, additionalProperties: false },
  },
  {
    name: "gmail_draft",
    description: "Save an email as a draft in the user's Gmail. With threadId it is a reply in that conversation.",
    inputSchema: { type: "object", properties: mail, required: ["to"], additionalProperties: false },
  },
  {
    name: "gmail_send",
    description: "Send an email from the user's Gmail, right now. Only when the user asked for this email to be sent (in this conversation or in the routine's instructions). With threadId it is a reply in that conversation.",
    inputSchema: { type: "object", properties: mail, required: ["to"], additionalProperties: false },
  },
];
async function call(name, args) {
  const res = name === "gmail_accounts"
    ? await fetch(base, { headers })
    : await fetch(base, { method: "POST", headers, body: JSON.stringify({ ...(args || {}), tool: name.replace(/^gmail_/, "") }) });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) return { isError: true, content: [{ type: "text", text: body.error || ("gmail: HTTP " + res.status) }] };
  return { content: [{ type: "text", text: typeof body.message === "string" && Object.keys(body).length <= 4 ? body.message : JSON.stringify(body, null, 2) }] };
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
        send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: (msg.params && msg.params.protocolVersion) || "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "nexus-gmail", version: "1.0.0" } } });
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
      send({ jsonrpc: "2.0", id: msg.id, result: { isError: true, content: [{ type: "text", text: "gmail: " + (e && e.message || e) }] } });
    }
  }
});
`;
}

export async function writeBotGmailScript(name: string, target?: DockerTarget | null): Promise<void> {
  const res = await dockerRun(target, ["exec", "-i", "-u", BOT_USER, name, "sh", "-c", `umask 077 && cat > ${BOT_GMAIL_MCP_SCRIPT}`], {
    stdin: renderGmailMcpScript(),
    timeoutMs: 15_000,
  });
  if (res.code !== 0) throw new Error(`could not write the Gmail script: ${res.stderr.slice(-200)}`);
}
