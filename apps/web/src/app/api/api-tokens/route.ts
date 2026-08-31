import { prisma } from "@nexux/db";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  API_SCOPES,
  generateToken,
  hashToken,
  parseScopes,
  tokenHint,
} from "@/lib/api-token";
import { publicOrigin } from "@/lib/public-origin";

export const dynamic = "force-dynamic";

/**
 * The `claude mcp add` line for a freshly issued token, so connecting is a
 * copy-paste rather than three fields assembled by hand.
 *
 * Single-quoted with the shell's own escape for an embedded quote, because the
 * pieces are interpolated: an origin can carry a quote (a malformed
 * NEXUX_WEB_ORIGIN, a crafted Host header) and unquoted interpolation into a
 * line a person will paste into their shell is the one place that matters.
 */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function mcpEndpoint(origin: string): string {
  return `${origin.replace(/\/+$/, "")}/api/mcp`;
}

export function claudeMcpAddCommand(origin: string, token: string): string {
  return [
    "claude mcp add nexux",
    "--transport http",
    shellQuote(mcpEndpoint(origin)),
    `--header ${shellQuote(`Authorization: Bearer ${token}`)}`,
  ].join(" ");
}

/**
 * Bearer tokens for the MCP control surface (spec 21). These routes manage the
 * tokens; they are not themselves token-authenticated — they are dashboard
 * routes, like every other route in this app.
 */

// The token value is never in a list response. It cannot be: only its sha-256
// is stored, so this is enforced by the schema rather than by remembering.
function toSummary(row: {
  id: string;
  name: string;
  scopes: unknown;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
}) {
  return {
    id: row.id,
    name: row.name,
    scopes: parseScopes(row.scopes),
    lastUsedAt: row.lastUsedAt,
    revokedAt: row.revokedAt,
    createdAt: row.createdAt,
  };
}

export async function GET() {
  const tokens = await prisma.apiToken.findMany({
    orderBy: [{ revokedAt: "asc" }, { createdAt: "desc" }],
  });
  return NextResponse.json(tokens.map(toSummary));
}

const createSchema = z.object({
  name: z.string().trim().min(1).max(60),
  // An empty scope list would mint a token that authenticates and can do
  // nothing, which reads as a broken token rather than a deliberate one.
  scopes: z
    .array(z.enum(API_SCOPES))
    .min(1, "Pick at least one scope")
    .refine((s) => new Set(s).size === s.length, "Duplicate scopes"),
});

export async function POST(req: NextRequest) {
  const parsed = createSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid body" },
      { status: 400 },
    );
  }

  const token = generateToken();
  const row = await prisma.apiToken.create({
    data: {
      name: parsed.data.name,
      hash: hashToken(token),
      scopes: parsed.data.scopes,
    },
  });

  // The only response that ever carries the token. There is no way to read it
  // back afterwards — losing it means issuing a new one, which is the point.
  //
  // The command ships with it so the token never has to be assembled by hand.
  // The URL comes from `publicOrigin` rather than a hardcoded localhost: the
  // dashboard is just as likely to be reached over a tailnet (D-53), and a
  // command naming the wrong host is worse than none — it fails at connect
  // time, far from here.
  return NextResponse.json(
    {
      ...toSummary(row),
      token,
      hint: tokenHint(token),
      mcpUrl: mcpEndpoint(publicOrigin(req)),
      command: claudeMcpAddCommand(publicOrigin(req), token),
    },
    { status: 201 },
  );
}
