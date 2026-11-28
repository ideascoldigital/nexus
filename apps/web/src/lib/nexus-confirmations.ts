// Approvals for what costs money in a project chat (spec 39). The tool asks;
// the chat shows a confirm card; the user's tap — an API call, not a chat
// message the model could write — approves exactly that action, once, for a
// while. Memory only: a pending approval does not survive a restart, and the
// chat simply asks again.

import { randomBytes } from "node:crypto";

type Pending = { id: string; botId: string; key: string; summary: string; approved: boolean; at: number };

const TTL_MS = 30 * 60_000;
const g = globalThis as unknown as { nexuxConfirmations?: Map<string, Pending> };
const byId = (g.nexuxConfirmations ??= new Map<string, Pending>());

function sweep(now = Date.now()) {
  for (const [id, p] of byId) if (now - p.at > TTL_MS) byId.delete(id);
}

/**
 * For the MCP context's gate: null when the user approved exactly this action
 * (the approval is used up), else the id of the pending approval.
 */
export function requireConfirmation(botId: string, action: { key: string; summary: string }): string | null {
  sweep();
  for (const p of byId.values()) {
    if (p.botId !== botId || p.key !== action.key) continue;
    if (p.approved) {
      byId.delete(p.id);
      return null;
    }
    return p.id;
  }
  const id = "act_" + randomBytes(6).toString("hex");
  byId.set(id, { id, botId, key: action.key, summary: action.summary, approved: false, at: Date.now() });
  return id;
}

/** The user tapped Confirm. Returns what was approved, or null if it is unknown or expired. */
export function approveConfirmation(botId: string, actionId: string): { summary: string } | null {
  sweep();
  const p = byId.get(actionId);
  if (!p || p.botId !== botId) return null;
  p.approved = true;
  p.at = Date.now();
  return { summary: p.summary };
}

/** The user tapped Cancel. */
export function dropConfirmation(botId: string, actionId: string): boolean {
  const p = byId.get(actionId);
  if (!p || p.botId !== botId) return false;
  byId.delete(actionId);
  return true;
}
