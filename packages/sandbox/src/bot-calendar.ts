/**
 * Google Calendar inside a bot's computer (spec 36): a dependency-free MCP
 * stdio server, written in with each prompt like Gmail's (spec 34). It holds
 * no Google token — only the running prompt's token — and relays every call to
 * Nexus, which talks to Calendar with the account's own token.
 */

import { BOT_HOME, BOT_USER, dockerRun } from "./bot";
import { type DockerTarget } from "./docker-endpoint";

export const BOT_CALENDAR_MCP_SCRIPT = `${BOT_HOME}/.nexux-calendar-mcp.js`;

/** The MCP server entry for the bot's config. The token rides in env (0600 file). */
export function botCalendarMcpServer(opts: { nexusUrl: string; botId: string; token: string }) {
  return {
    command: "node",
    args: [BOT_CALENDAR_MCP_SCRIPT],
    env: { NEXUS_URL: opts.nexusUrl, NEXUX_BOT_ID: opts.botId, NEXUX_VAULT_TOKEN: opts.token },
  };
}

export function renderCalendarMcpScript(): string {
  return `// Nexus Google Calendar MCP server (spec 36). Holds no Google token.
const base = (process.env.NEXUS_URL || "").replace(/\\/$/, "") + "/api/bots/" + process.env.NEXUX_BOT_ID + "/calendar";
const headers = { "content-type": "application/json", "x-nexux-vault-token": process.env.NEXUX_VAULT_TOKEN || "" };
const account = { type: "string", description: "Which connected Google account to use. Leave it out when you have only one." };
const calendarId = { type: "string", description: "A calendar id from calendar_calendars. Leave it out for the user's main calendar." };
const instant = (what) => ({ type: "string", description: what + " — a date and time with the offset, e.g. 2026-11-24T00:00:00-05:00" });
const event = {
  summary: { type: "string", description: "The event's title" },
  start: { type: "string", description: "2026-11-24T10:00 (in the user's time zone unless timeZone is given), with an offset like 2026-11-24T10:00:00-05:00, or 2026-11-24 for an all-day event" },
  end: { type: "string", description: "Same format as start. For an all-day event it is the day after the last day, and can be left out for a single day" },
  timeZone: { type: "string", description: "IANA name (America/Bogota) for times written without an offset. Defaults to the user's" },
  description: { type: "string" },
  location: { type: "string" },
  attendees: { type: "string", description: "Comma-separated email addresses. This is the full guest list: on an update it replaces the old one" },
  meet: { type: "boolean", description: "Add a Google Meet link" },
  notify: { type: "boolean", description: "Email the guests about it. Only when the user asked for invitations to go out. Default false" },
};
const tools = [
  {
    name: "calendar_accounts",
    description: "The Google accounts whose calendars you can use.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "calendar_calendars",
    description: "The calendars of an account (the main one, shared and subscribed ones) with their ids and whether you can add events to them.",
    inputSchema: { type: "object", properties: { account }, additionalProperties: false },
  },
  {
    name: "calendar_events",
    description: "Events between two instants, in order, recurring events expanded. Optional text search. Use it to read the agenda.",
    inputSchema: { type: "object", properties: { account, calendarId, timeMin: instant("From"), timeMax: instant("Until"), query: { type: "string", description: "Free text matched against title, description, location and guests" }, max: { type: "number", description: "1–100, default 50" } }, required: ["timeMin", "timeMax"], additionalProperties: false },
  },
  {
    name: "calendar_get_event",
    description: "One event in full, with its whole description and guest list.",
    inputSchema: { type: "object", properties: { account, calendarId, eventId: { type: "string" } }, required: ["eventId"], additionalProperties: false },
  },
  {
    name: "calendar_freebusy",
    description: "Busy blocks between two instants, for the user's calendar or others' (email addresses or calendar ids) — to find a free slot. Others only show what they share.",
    inputSchema: { type: "object", properties: { account, timeMin: instant("From"), timeMax: instant("Until"), calendars: { type: "array", items: { type: "string" }, description: "Default: the user's main calendar" } }, required: ["timeMin", "timeMax"], additionalProperties: false },
  },
  {
    name: "calendar_create_event",
    description: "Create an event. Guests are added to it; they are emailed only with notify: true.",
    inputSchema: { type: "object", properties: { account, calendarId, ...event }, required: ["summary", "start"], additionalProperties: false },
  },
  {
    name: "calendar_update_event",
    description: "Change an event: only the fields given. To move it give both start and end.",
    inputSchema: { type: "object", properties: { account, calendarId, eventId: { type: "string" }, ...event }, required: ["eventId"], additionalProperties: false },
  },
  {
    name: "calendar_delete_event",
    description: "Delete (cancel) an event. Only when the user asked for it. notify: true emails the guests that it was cancelled.",
    inputSchema: { type: "object", properties: { account, calendarId, eventId: { type: "string" }, notify: event.notify }, required: ["eventId"], additionalProperties: false },
  },
];
async function call(name, args) {
  const res = name === "calendar_accounts"
    ? await fetch(base, { headers })
    : await fetch(base, { method: "POST", headers, body: JSON.stringify({ ...(args || {}), tool: name.replace(/^calendar_/, "") }) });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) return { isError: true, content: [{ type: "text", text: body.error || ("calendar: HTTP " + res.status) }] };
  return { content: [{ type: "text", text: typeof body.message === "string" && Object.keys(body).length === 1 ? body.message : JSON.stringify(body, null, 2) }] };
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
        send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: (msg.params && msg.params.protocolVersion) || "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "nexus-calendar", version: "1.0.0" } } });
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
      send({ jsonrpc: "2.0", id: msg.id, result: { isError: true, content: [{ type: "text", text: "calendar: " + (e && e.message || e) }] } });
    }
  }
});
`;
}

export async function writeBotCalendarScript(name: string, target?: DockerTarget | null): Promise<void> {
  const res = await dockerRun(target, ["exec", "-i", "-u", BOT_USER, name, "sh", "-c", `umask 077 && cat > ${BOT_CALENDAR_MCP_SCRIPT}`], {
    stdin: renderCalendarMcpScript(),
    timeoutMs: 15_000,
  });
  if (res.code !== 0) throw new Error(`could not write the Calendar script: ${res.stderr.slice(-200)}`);
}
