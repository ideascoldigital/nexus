// A bot's own MCP servers (spec 31). Claude Code's native `mcpServers` shape —
// the same JSON a project's sandbox takes:
//
//   { "context7": { "command": "npx", "args": ["-y", "@upstash/context7-mcp"] },
//     "my-api":   { "type": "http", "url": "https://mcp.example.com", "headers": { … } } }
//
// Loaded into the bot's computer next to its browser MCP on every prompt.
// Pure and client-safe: the settings form and the API validate with it.

export type BotMcpServers = Record<string, Record<string, unknown>>;

/** Servers Nexus adds itself (the visible-Chromium MCP, the vault); a bot's own list can't replace them. */
export const RESERVED_MCP_NAMES = ["browser", "vault", "gmail", "calendar"] as const;

const NAME = /^[A-Za-z0-9_-]{1,40}$/;
const TYPES = ["stdio", "http", "sse"];

/**
 * Check a parsed mcpServers object. Returns the servers (null when empty) or
 * the first problem, worded for the user.
 */
export function validateBotMcpServers(raw: unknown): { ok: true; servers: BotMcpServers | null } | { ok: false; error: string } {
  if (raw === null || raw === undefined) return { ok: true, servers: null };
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: 'Expected { "<name>": { "command": … } or { "type": "http", "url": … } }' };
  }
  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length > 20) return { ok: false, error: "At most 20 MCP servers per bot" };
  for (const [name, def] of entries) {
    if (!NAME.test(name)) return { ok: false, error: `"${name}": names are letters, digits, - and _ (up to 40)` };
    if ((RESERVED_MCP_NAMES as readonly string[]).includes(name)) {
      return { ok: false, error: `"${name}" is used by Nexus (the bot's browser, vault or Gmail) — pick another name` };
    }
    if (!def || typeof def !== "object" || Array.isArray(def)) return { ok: false, error: `"${name}": expected an object` };
    const d = def as Record<string, unknown>;
    if (d.type !== undefined && !TYPES.includes(String(d.type))) {
      return { ok: false, error: `"${name}": type is stdio, http or sse` };
    }
    const remote = d.type === "http" || d.type === "sse";
    if (remote) {
      if (typeof d.url !== "string" || !/^https?:\/\/\S+$/.test(d.url)) return { ok: false, error: `"${name}": needs a url (http:// or https://)` };
      if (d.headers !== undefined && !stringMap(d.headers)) return { ok: false, error: `"${name}": headers must be text values` };
    } else {
      if (typeof d.command !== "string" || !d.command.trim()) {
        return { ok: false, error: `"${name}": needs a command (or "type": "http" with a url)` };
      }
      if (d.args !== undefined && !(Array.isArray(d.args) && d.args.every((a) => typeof a === "string"))) {
        return { ok: false, error: `"${name}": args must be a list of text values` };
      }
      if (d.env !== undefined && !stringMap(d.env)) return { ok: false, error: `"${name}": env must be text values` };
    }
  }
  return { ok: true, servers: entries.length ? (raw as BotMcpServers) : null };
}

/** The settings textarea's text → servers, or the problem. Empty text clears them. */
export function parseBotMcpJson(text: string): { ok: true; servers: BotMcpServers | null } | { ok: false; error: string } {
  const t = text.trim();
  if (!t) return { ok: true, servers: null };
  let parsed: unknown;
  try {
    parsed = JSON.parse(t);
  } catch {
    return { ok: false, error: "Not valid JSON" };
  }
  // Pasted a whole .mcp.json / claude config? Take its mcpServers.
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && "mcpServers" in parsed) {
    parsed = (parsed as { mcpServers: unknown }).mcpServers;
  }
  return validateBotMcpServers(parsed);
}

export function mcpServerNames(servers: unknown): string[] {
  const v = validateBotMcpServers(servers);
  return v.ok && v.servers ? Object.keys(v.servers) : [];
}

function stringMap(v: unknown): boolean {
  return Boolean(v) && typeof v === "object" && !Array.isArray(v) && Object.values(v as object).every((x) => typeof x === "string");
}
