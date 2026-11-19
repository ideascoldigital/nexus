// Which bot may use the vault right now (spec 32). A token is minted for each
// prompt a bot runs and revoked when it ends: the vault MCP server inside the
// computer presents it, so a stale config file — or another container — gets
// nothing. In memory on purpose: a Nexus restart ends every run anyway.

import { randomBytes, timingSafeEqual } from "node:crypto";

type Grant = { botId: string; runId: string; container: string };

const g = globalThis as unknown as { nexuxVaultGrants?: Map<string, Grant> };
const grants = (g.nexuxVaultGrants ??= new Map<string, Grant>());

export function grantVault(grant: Grant): string {
  const token = randomBytes(24).toString("base64url");
  grants.set(token, grant);
  return token;
}

export function revokeVault(token: string | null | undefined): void {
  if (token) grants.delete(token);
}

/** The grant behind a token, if it is live and belongs to this bot. */
export function checkVault(token: string | null | undefined, botId: string): Grant | null {
  if (!token) return null;
  for (const [t, grant] of grants) {
    if (t.length === token.length && timingSafeEqual(Buffer.from(t), Buffer.from(token)) && grant.botId === botId) return grant;
  }
  return null;
}
