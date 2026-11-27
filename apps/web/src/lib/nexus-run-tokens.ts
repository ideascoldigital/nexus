// Per-run access for the Nexus chat (spec 39). Each run of the assistant gets
// a fresh bearer for /api/mcp that lives only in this process's memory — never
// in the database, never in a file — scoped to the tools it may use and to the
// workspace the chat belongs to, and revoked when the run ends.

import { randomBytes } from "node:crypto";

import type { Scope } from "@nexux/mcp";

import { hashToken } from "@/lib/api-token";

export type RunGrant = {
  scopes: Scope[];
  workspaceId: string;
  onProjectCreated?: (projectId: string) => void;
  /** Gate for what costs money (see nexus-confirmations). */
  confirm?: (action: { key: string; summary: string }) => string | null;
  onSandboxLaunched?: (sandboxId: string) => void;
  /** Tools its scopes would allow that this run still may not call. */
  deny?: string[];
};

const g = globalThis as unknown as { nexuxRunGrants?: Map<string, RunGrant> };
const grants = (g.nexuxRunGrants ??= new Map<string, RunGrant>());

/** A token for one run; `revoke` ends it. */
export function grantRun(grant: RunGrant): { token: string; revoke: () => void } {
  const token = "nxr_" + randomBytes(32).toString("hex");
  const key = hashToken(token);
  grants.set(key, grant);
  return { token, revoke: () => grants.delete(key) };
}

/** The grant behind a bearer, if it is a live run token. */
export function runGrantFor(bearer: string | null): RunGrant | null {
  if (!bearer || !bearer.startsWith("nxr_")) return null;
  return grants.get(hashToken(bearer)) ?? null;
}
