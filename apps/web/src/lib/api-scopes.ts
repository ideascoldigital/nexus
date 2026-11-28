/**
 * Scope names for the MCP control surface (spec 21), split out from
 * `api-token.ts` because that module reaches Prisma — a client component
 * importing the scope list from there would drag the database client into the
 * browser bundle.
 *
 * Split by blast radius rather than by route: `sandboxes:write` provisions
 * real Civo/AWS instances and costs money, so a token handed to an external
 * system can dispatch work onto machines that already exist without also
 * being able to buy new ones.
 */
export const API_SCOPES = [
  "projects:read",
  "projects:write",
  "files:read",
  "files:write",
  "tasks:read",
  "tasks:write",
  "sandboxes:read",
  "sandboxes:write",
] as const;

export type ApiScope = (typeof API_SCOPES)[number];

export function isApiScope(value: string): value is ApiScope {
  return (API_SCOPES as readonly string[]).includes(value);
}
