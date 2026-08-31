import { createHash, randomBytes, timingSafeEqual } from "crypto";
import { prisma } from "@nexux/db";

/**
 * Bearer tokens for the MCP control surface (spec 21). This is the first
 * inbound programmatic path into Nexus — everything else is either the
 * dashboard itself or outbound (Telegram) — so the rules here are the whole
 * auth story, not a layer over an existing one.
 */

// The scope list lives in its own Prisma-free module so client components can
// import it without pulling the database client into the browser bundle.
export { API_SCOPES, isApiScope, type ApiScope } from "./api-scopes";
import { isApiScope, type ApiScope } from "./api-scopes";

/** Tokens are recognisable on sight, so a leaked one is identifiable as ours. */
const PREFIX = "nxs_";

/**
 * 32 bytes of randomness, hex-encoded. Long enough that guessing is not a
 * threat model, so the only way a token leaks is by being stored or shown —
 * which is what `hashToken` and the show-once rule address.
 */
export function generateToken(): string {
  return PREFIX + randomBytes(32).toString("hex");
}

/**
 * Tokens are stored only as their sha-256. Unsalted and un-stretched on
 * purpose: this is a 256-bit random value, not a human-chosen password, so
 * there is no dictionary to defend against and a per-row salt would only
 * prevent the unique-index lookup that makes verification a single query.
 */
export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** Constant-time compare over two hex digests of equal length. */
function digestsEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "hex");
  const bb = Buffer.from(b, "hex");
  if (ab.length !== bb.length || ab.length === 0) return false;
  return timingSafeEqual(ab, bb);
}

/** Pulls the bearer value out of an Authorization header. */
export function bearerFrom(header: string | null | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer[ \t]+(\S+)$/i.exec(header.trim());
  return match ? match[1] : null;
}

export type VerifiedToken = {
  id: string;
  name: string;
  scopes: ApiScope[];
};

/**
 * `scopes` is Json in the schema (sqlite has no array type), so it arrives as
 * `unknown`. A row whose scopes are malformed grants nothing rather than
 * throwing: a token that cannot be understood must not be a token that works.
 */
export function parseScopes(value: unknown): ApiScope[] {
  if (!Array.isArray(value)) return [];
  return value.filter((s): s is ApiScope => typeof s === "string" && isApiScope(s));
}

/**
 * Looks a token up by hash and reports what it may do. Returns null for
 * unknown, malformed and revoked tokens alike — the caller answers all three
 * with the same bare 401, since telling a prober which of the three they hit
 * tells them whether the token value itself was right.
 *
 * `lastUsedAt` is touched on every accepted call so a token nobody remembers
 * issuing is visible in Settings as one that is still being used. The write is
 * fire-and-forget: a failure to record usage must not fail the request.
 */
export async function verifyToken(
  token: string | null,
): Promise<VerifiedToken | null> {
  if (!token || !token.startsWith(PREFIX)) return null;

  const hash = hashToken(token);
  const row = await prisma.apiToken.findUnique({ where: { hash } });
  if (!row || row.revokedAt) return null;

  // The unique index already selected this row by hash; the constant-time
  // compare is belt-and-braces against a future lookup that is not an exact
  // match (a prefix scan, say), where timing would otherwise leak.
  if (!digestsEqual(hash, row.hash)) return null;

  void prisma.apiToken
    .update({ where: { id: row.id }, data: { lastUsedAt: new Date() } })
    .catch(() => undefined);

  return { id: row.id, name: row.name, scopes: parseScopes(row.scopes) };
}

/** Whether a verified token carries a scope. */
export function hasScope(
  verified: VerifiedToken | null,
  scope: ApiScope,
): boolean {
  return verified?.scopes.includes(scope) ?? false;
}

/** Last 4 characters, for a Settings list that must not show the token. */
export function tokenHint(token: string): string {
  return "…" + token.slice(-4);
}
