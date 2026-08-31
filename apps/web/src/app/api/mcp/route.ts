import { NextRequest, NextResponse } from "next/server";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { callTool, toolsFor, type Scope } from "@nexux/mcp";

import { bearerFrom, verifyToken } from "@/lib/api-token";
import { createMcpContext } from "@/lib/mcp-context";

export const dynamic = "force-dynamic";

/**
 * The MCP control surface (spec 21): how a local Claude — or any other system
 * holding a token — drives this Nexus.
 *
 * Stateless by design. `sessionIdGenerator` is omitted, so every request
 * carries its own transport and server: there is no session to resume, and a
 * token is re-verified on each call rather than exchanged once for something
 * longer-lived. That costs a database lookup per request and buys the property
 * that revoking a token stops it working immediately, which is the entire
 * reason revocation exists.
 */

/** Package identity as reported to clients during initialize. */
const SERVER_INFO = { name: "nexux", version: "0.1.0" };

function unauthorized() {
  // No body, and the same answer for absent, malformed, unknown and revoked
  // tokens alike. Distinguishing them tells a prober which half they got right.
  return new NextResponse(null, {
    status: 401,
    headers: { "WWW-Authenticate": 'Bearer realm="nexux"' },
  });
}

export async function POST(req: NextRequest) {
  const verified = await verifyToken(bearerFrom(req.headers.get("authorization")));
  if (!verified) return unauthorized();

  const scopes = verified.scopes as Scope[];
  const ctx = createMcpContext();

  const server = new Server(SERVER_INFO, { capabilities: { tools: {} } });

  // Listing is filtered to the token's scopes, not merely calling: advertising
  // a tool that would always be refused invites a client to keep trying it,
  // and tells the holder of a narrow token what a broader one could do.
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: toolsFor(scopes),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const result = await callTool(
      ctx,
      scopes,
      request.params.name,
      request.params.arguments,
    );

    // A refused or failed call is a tool result flagged `isError`, not a
    // protocol error: the model should see what went wrong and adapt, which is
    // the difference between "that sandbox is busy" reaching the client and
    // the request simply failing.
    return {
      content: [
        {
          type: "text" as const,
          text: result.ok
            ? JSON.stringify(result.result, null, 2)
            : result.error,
        },
      ],
      isError: !result.ok,
    };
  });

  const transport = new WebStandardStreamableHTTPServerTransport({
    // Stateless: no session id, so nothing to keep between requests.
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });

  await server.connect(transport);

  try {
    return await transport.handleRequest(req);
  } finally {
    // Each request owns its transport; leaving them open would leak one per
    // call for the lifetime of the process.
    await transport.close().catch(() => undefined);
    await server.close().catch(() => undefined);
  }
}

/**
 * The streamable-HTTP spec uses GET to open a server-to-client event stream.
 * Nexus has nothing to push — every tool here is request/response — so this
 * says so rather than leaving a stream open that will never carry anything.
 */
export function GET() {
  return NextResponse.json(
    { error: "This MCP server does not offer a server-initiated event stream" },
    { status: 405, headers: { Allow: "POST" } },
  );
}
