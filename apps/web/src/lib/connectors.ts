// The connectors catalog (spec 35): apps a user connects once and their bots
// then use as tools — an MCP server Nexus adds to each bot's computer on every
// prompt, next to the browser. Gmail (spec 34) and Google Calendar (spec 36)
// are built into Nexus;
// the rest are the apps' own MCP servers, run in the computer (npx) or reached
// over HTTP, with the token the user pasted. What the user typed is sealed in
// the Connector row; this file only describes the entries and turns typed
// values into a server definition. Pure and client-safe.

import type { BotMcpServers } from "@/lib/bot-mcp";

export type ConnectorCategory = "Communication" | "Productivity" | "Developer" | "Data" | "Sales" | "Payments" | "Search";

export const CONNECTOR_CATEGORIES: ConnectorCategory[] = [
  "Communication",
  "Productivity",
  "Developer",
  "Data",
  "Sales",
  "Payments",
  "Search",
];

export type ConnectorField = {
  key: string;
  label: string;
  /** secret: a token, never sent back to the browser. toggle: on/off. */
  type: "text" | "secret" | "toggle";
  placeholder?: string;
  optional?: boolean;
  /** For a toggle: on unless the user turns it off. */
  defaultOn?: boolean;
  help?: string;
  /** A sanity check on what was pasted (not proof that it works). */
  pattern?: RegExp;
};

export type ConnectorDef = {
  id: string;
  name: string;
  category: ConnectorCategory;
  /** One line under the name: what bots can do with it. */
  tagline: string;
  /** Built into Nexus with its own setup (Gmail, Calendar), or an MCP server built from the fields. */
  kind: "native" | "mcp";
  /** How to get what the fields ask for, step by step. */
  steps?: { text: string; url?: string; label?: string }[];
  fields: ConnectorField[];
  server?: (v: Record<string, string>) => Record<string, unknown>;
};

const on = (v: string | undefined) => v === "true";

export const CONNECTORS: ConnectorDef[] = [
  {
    id: "gmail",
    name: "Gmail",
    category: "Communication",
    tagline: "Search, read, draft and send email",
    kind: "native",
    fields: [],
  },
  {
    id: "google-calendar",
    name: "Google Calendar",
    category: "Productivity",
    tagline: "Read the agenda, find free time, schedule and move events",
    kind: "native",
    fields: [],
  },
  {
    id: "slack",
    name: "Slack",
    category: "Communication",
    tagline: "Read channels, post messages and replies",
    kind: "mcp",
    steps: [
      { text: "Create a Slack app for your workspace", url: "https://api.slack.com/apps?new_app=1", label: "api.slack.com/apps" },
      { text: "Under OAuth & Permissions, add the bot scopes channels:history, channels:read, chat:write, reactions:write, users:read and install the app" },
      { text: "Copy the Bot User OAuth Token (xoxb-…) and your workspace's Team ID (starts with T)" },
      { text: "Invite the app to the channels your bots should see" },
    ],
    fields: [
      { key: "token", label: "Bot token", type: "secret", placeholder: "xoxb-…", pattern: /^xoxb-/ },
      { key: "teamId", label: "Team ID", type: "text", placeholder: "T01234567", pattern: /^T[A-Z0-9]+$/ },
    ],
    server: (v) => ({
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-slack"],
      env: { SLACK_BOT_TOKEN: v.token, SLACK_TEAM_ID: v.teamId },
    }),
  },
  {
    id: "notion",
    name: "Notion",
    category: "Productivity",
    tagline: "Search, read and edit pages and databases",
    kind: "mcp",
    steps: [
      { text: "Create an internal integration", url: "https://www.notion.so/profile/integrations", label: "notion.so/profile/integrations" },
      { text: "Copy its Internal Integration Secret" },
      { text: "In Notion, share the pages your bots should see with the integration (••• → Connections)" },
    ],
    fields: [{ key: "token", label: "Integration secret", type: "secret", placeholder: "ntn_…" }],
    server: (v) => ({ command: "npx", args: ["-y", "@notionhq/notion-mcp-server"], env: { NOTION_TOKEN: v.token } }),
  },
  {
    id: "airtable",
    name: "Airtable",
    category: "Productivity",
    tagline: "Read and update bases, tables and records",
    kind: "mcp",
    steps: [
      { text: "Create a personal access token", url: "https://airtable.com/create/tokens", label: "airtable.com/create/tokens" },
      { text: "Give it data.records:read (and :write to let bots edit), schema.bases:read, and the bases bots may use" },
    ],
    fields: [{ key: "token", label: "Personal access token", type: "secret", placeholder: "pat…", pattern: /^pat/ }],
    server: (v) => ({ command: "npx", args: ["-y", "airtable-mcp-server"], env: { AIRTABLE_API_KEY: v.token } }),
  },
  {
    id: "github",
    name: "GitHub",
    category: "Developer",
    tagline: "Issues, pull requests, code and repositories",
    kind: "mcp",
    steps: [
      { text: "Create a fine-grained personal access token", url: "https://github.com/settings/personal-access-tokens/new", label: "github.com/settings/tokens" },
      { text: "Pick the repositories bots may use and the permissions they need (Issues, Pull requests, Contents)" },
    ],
    fields: [
      { key: "token", label: "Personal access token", type: "secret", placeholder: "github_pat_…", pattern: /^(github_pat_|ghp_)/ },
      { key: "readOnly", label: "Read only", type: "toggle", defaultOn: true, help: "Bots can look but not create or change anything" },
    ],
    server: (v) => ({
      type: "http",
      url: "https://api.githubcopilot.com/mcp/",
      headers: { Authorization: `Bearer ${v.token}`, ...(on(v.readOnly) ? { "X-MCP-Readonly": "true" } : {}) },
    }),
  },
  {
    id: "mongodb",
    name: "MongoDB",
    category: "Data",
    tagline: "Query collections in your Atlas or MongoDB database",
    kind: "mcp",
    steps: [
      { text: "In Atlas → Database Access, create a database user with the read-only role (readAnyDatabase)", url: "https://cloud.mongodb.com", label: "cloud.mongodb.com" },
      { text: "In Network Access, allow your network's IP — bots' computers go out through this Mac" },
      { text: "Copy the connection string (Connect → Drivers) with that user's password in it" },
    ],
    fields: [
      { key: "uri", label: "Connection string", type: "secret", placeholder: "mongodb+srv://user:password@cluster…", pattern: /^mongodb(\+srv)?:\/\// },
      { key: "readOnly", label: "Read only", type: "toggle", defaultOn: true, help: "Bots can query but never insert, update or delete" },
    ],
    server: (v) => ({
      command: "npx",
      args: ["-y", "mongodb-mcp-server", ...(on(v.readOnly) ? ["--readOnly"] : [])],
      env: { MDB_MCP_CONNECTION_STRING: v.uri },
    }),
  },
  {
    id: "postgres",
    name: "PostgreSQL",
    category: "Data",
    tagline: "Read-only SQL queries on a Postgres database",
    kind: "mcp",
    steps: [{ text: "Create a database role with read-only access and paste its connection string" }],
    fields: [{ key: "uri", label: "Connection string", type: "secret", placeholder: "postgresql://user:password@host:5432/db", pattern: /^postgres(ql)?:\/\// }],
    server: (v) => ({ command: "npx", args: ["-y", "@modelcontextprotocol/server-postgres", v.uri] }),
  },
  {
    id: "supabase",
    name: "Supabase",
    category: "Data",
    tagline: "Tables, SQL and logs of a Supabase project",
    kind: "mcp",
    steps: [
      { text: "Create a personal access token", url: "https://supabase.com/dashboard/account/tokens", label: "supabase.com/dashboard/account/tokens" },
      { text: "Copy the project's reference id (Project Settings → General)" },
    ],
    fields: [
      { key: "token", label: "Access token", type: "secret", placeholder: "sbp_…", pattern: /^sbp_/ },
      { key: "projectRef", label: "Project ref", type: "text", placeholder: "abcdefghijklmnop", pattern: /^[a-z0-9]{10,40}$/ },
      { key: "readOnly", label: "Read only", type: "toggle", defaultOn: true, help: "SQL runs as a read-only user" },
    ],
    server: (v) => ({
      command: "npx",
      args: ["-y", "@supabase/mcp-server-supabase", `--project-ref=${v.projectRef}`, ...(on(v.readOnly) ? ["--read-only"] : [])],
      env: { SUPABASE_ACCESS_TOKEN: v.token },
    }),
  },
  {
    id: "hubspot",
    name: "HubSpot",
    category: "Sales",
    tagline: "Contacts, companies, deals and notes in your CRM",
    kind: "mcp",
    steps: [
      { text: "In HubSpot, create a private app (Settings → Integrations → Private Apps)", url: "https://app.hubspot.com/private-apps", label: "HubSpot private apps" },
      { text: "Give it the CRM scopes bots need, then copy its access token" },
    ],
    fields: [{ key: "token", label: "Private app token", type: "secret", placeholder: "pat-…", pattern: /^pat-/ }],
    server: (v) => ({ command: "npx", args: ["-y", "@hubspot/mcp-server"], env: { PRIVATE_APP_ACCESS_TOKEN: v.token } }),
  },
  {
    id: "stripe",
    name: "Stripe",
    category: "Payments",
    tagline: "Customers, payments, invoices and subscriptions",
    kind: "mcp",
    steps: [
      { text: "Create a restricted key with only the permissions bots need", url: "https://dashboard.stripe.com/apikeys", label: "dashboard.stripe.com/apikeys" },
    ],
    fields: [{ key: "token", label: "Restricted key", type: "secret", placeholder: "rk_live_…", pattern: /^(rk|sk)_(live|test)_/ }],
    server: (v) => ({ type: "http", url: "https://mcp.stripe.com", headers: { Authorization: `Bearer ${v.token}` } }),
  },
  {
    id: "brave-search",
    name: "Brave Search",
    category: "Search",
    tagline: "Web, news and image search without a browser",
    kind: "mcp",
    steps: [{ text: "Get a free API key", url: "https://api-dashboard.search.brave.com/app/keys", label: "api-dashboard.search.brave.com" }],
    fields: [{ key: "token", label: "API key", type: "secret", placeholder: "BSA…" }],
    server: (v) => ({ command: "npx", args: ["-y", "@brave/brave-search-mcp-server"], env: { BRAVE_API_KEY: v.token } }),
  },
];

export function connectorById(id: string): ConnectorDef | undefined {
  return CONNECTORS.find((c) => c.id === id);
}

/**
 * What the user typed → the values to store, or the first problem. An empty
 * secret keeps the one already stored (editing without retyping the token).
 */
export function validateConnectorValues(
  def: ConnectorDef,
  input: Record<string, unknown>,
  stored: Record<string, string> = {},
): { ok: true; values: Record<string, string> } | { ok: false; error: string } {
  const values: Record<string, string> = {};
  for (const f of def.fields) {
    const raw = input[f.key];
    if (f.type === "toggle") {
      values[f.key] = raw === undefined ? (stored[f.key] ?? String(f.defaultOn ?? false)) : String(raw === true || raw === "true");
      continue;
    }
    let v = typeof raw === "string" ? raw.trim() : "";
    if (!v && f.type === "secret" && stored[f.key]) v = stored[f.key]!;
    if (!v) {
      if (f.optional) continue;
      return { ok: false, error: `${f.label} is required` };
    }
    if (v.length > 4000 || /[\r\n]/.test(v)) return { ok: false, error: `${f.label} doesn't look right` };
    if (f.pattern && !f.pattern.test(v)) {
      return { ok: false, error: `${f.label} doesn't look right${f.placeholder ? ` — expected something like ${f.placeholder}` : ""}` };
    }
    values[f.key] = v;
  }
  return { ok: true, values };
}

/** What the browser may see: plain values, and only *whether* each secret is set. */
export function publicValues(def: ConnectorDef, values: Record<string, string>): { values: Record<string, string>; secretsSet: string[] } {
  const out: Record<string, string> = {};
  const secretsSet: string[] = [];
  for (const f of def.fields) {
    if (values[f.key] === undefined) continue;
    if (f.type === "secret") secretsSet.push(f.key);
    else out[f.key] = values[f.key]!;
  }
  return { values: out, secretsSet };
}

/** The MCP servers connected apps give one bot (connector id → server). */
export function connectorServers(rows: { id: string; values: Record<string, string> }[]): BotMcpServers {
  const out: BotMcpServers = {};
  for (const r of rows) {
    const def = connectorById(r.id);
    if (!def?.server) continue;
    const checked = validateConnectorValues(def, {}, r.values);
    if (checked.ok) out[def.id] = def.server(checked.values);
  }
  return out;
}
