/**
 * Connectors (spec 35), the I/O half: which catalog apps are connected, with
 * what (sealed in Connector.config), and for which bots. The tokens stay in
 * this process; the browser only learns whether each one is set, and a bot's
 * computer gets them inside the MCP server definition for the prompt it runs.
 */

import { Prisma, prisma } from "@nexux/db";

import { accountBotIds, botMayUseAccount } from "@/lib/gmail";
import {
  CONNECTORS,
  connectorById,
  connectorServers,
  publicValues,
  validateConnectorValues,
} from "@/lib/connectors";
import type { BotMcpServers } from "@/lib/bot-mcp";
import { listGoogleAccounts } from "@/services/google";

export type ConnectorStatus = {
  id: string;
  connected: boolean;
  /** null = every bot. */
  botIds: string[] | null;
  /** Plain values as saved (toggles, ids); never a secret. */
  values: Record<string, string>;
  /** Which secret fields hold a value. */
  secretsSet: string[];
  /** Gmail, Google Calendar: how many accounts have the app. */
  accounts?: number;
  updatedAt: string | null;
};

const storedValues = (config: unknown): Record<string, string> => {
  const out: Record<string, string> = {};
  if (config && typeof config === "object" && !Array.isArray(config)) {
    for (const [k, v] of Object.entries(config)) if (typeof v === "string") out[k] = v;
  }
  return out;
};

export async function listConnectors(): Promise<ConnectorStatus[]> {
  const [rows, google] = await Promise.all([prisma.connector.findMany(), listGoogleAccounts()]);
  return CONNECTORS.map((def) => {
    // The Google apps: connected when some account carries the app's scopes.
    const googleApp = def.id === "gmail" ? "gmail" : def.id === "google-calendar" ? "calendar" : null;
    if (googleApp) {
      const n = google.filter((a) => a.status === "connected" && a.apps.includes(googleApp)).length;
      return { id: def.id, connected: n > 0, botIds: null, values: {}, secretsSet: [], accounts: n, updatedAt: null };
    }
    const row = rows.find((r) => r.id === def.id);
    const shown = row ? publicValues(def, storedValues(row.config)) : { values: {}, secretsSet: [] };
    return {
      id: def.id,
      connected: Boolean(row),
      botIds: row ? accountBotIds({ botIds: row.botIds }) : null,
      ...shown,
      updatedAt: row ? row.updatedAt.toISOString() : null,
    };
  });
}

export class ConnectorError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

/** Connect an app, or change what it was connected with. */
export async function saveConnector(id: string, input: Record<string, unknown>, botIds?: string[] | null): Promise<void> {
  const def = connectorById(id);
  if (!def || def.kind !== "mcp") throw new ConnectorError("Unknown connector", 404);
  const row = await prisma.connector.findUnique({ where: { id } });
  const checked = validateConnectorValues(def, input, row ? storedValues(row.config) : {});
  if (!checked.ok) throw new ConnectorError(checked.error);
  const access = botIds === undefined ? undefined : botIds?.length ? botIds : Prisma.DbNull;
  // Top-level writes: the vault extension seals config.
  if (row) {
    await prisma.connector.update({ where: { id }, data: { config: checked.values, ...(access !== undefined ? { botIds: access } : {}) } });
  } else {
    await prisma.connector.create({ data: { id, config: checked.values, botIds: access ?? Prisma.DbNull } });
  }
}

export async function setConnectorBots(id: string, botIds: string[] | null): Promise<boolean> {
  const res = await prisma.connector.updateMany({ where: { id }, data: { botIds: botIds?.length ? botIds : Prisma.DbNull } });
  return res.count > 0;
}

export async function removeConnector(id: string): Promise<boolean> {
  const res = await prisma.connector.deleteMany({ where: { id } });
  return res.count > 0;
}

/** The MCP servers a bot gets from connected apps, ready for its computer. */
export async function connectorServersFor(botId: string): Promise<BotMcpServers> {
  const rows = await prisma.connector.findMany();
  return connectorServers(
    rows.filter((r) => botMayUseAccount({ botIds: r.botIds }, botId)).map((r) => ({ id: r.id, values: storedValues(r.config) })),
  );
}
