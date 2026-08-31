import assert from "node:assert/strict";
import { before, beforeEach, test } from "node:test";

// Env setup must stay above every other import — the route modules reach
// @nexux/db, whose client is built (and migrated) at module load.
import "./routes.test-setup";
import { NextRequest } from "next/server";
import { prisma } from "@nexux/db";

import { GET as mcpGet, POST as mcpPost } from "./mcp/route";
import { generateToken, hashToken } from "@/lib/api-token";
import type { ApiScope } from "@/lib/api-scopes";

/**
 * The transport's job is authentication and dispatch — the tools themselves
 * are covered in @nexux/mcp against a stub context. What matters here is that
 * a token is what decides, on every single request.
 */

let liveToken: string;
let readOnlyToken: string;
let revokedToken: string;
let projectId: string;

const rpc = (body: unknown, token?: string) =>
  mcpPost(
    new NextRequest("http://localhost/api/mcp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    }),
  );

const listTools = (token?: string) =>
  rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" }, token);

const call = (name: string, args: unknown, token?: string) =>
  rpc(
    {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name, arguments: args },
    },
    token,
  );

/** The SDK answers JSON-RPC; pull the result payload out of the envelope. */
async function payload(res: Response) {
  const text = await res.text();
  // With enableJsonResponse the body is plain JSON, but a client that asked
  // for a stream may receive SSE framing — accept both.
  const jsonLine = text.startsWith("data:")
    ? text.split("\n").find((l) => l.startsWith("data:"))!.slice(5).trim()
    : text;
  return JSON.parse(jsonLine);
}

async function mintToken(name: string, scopes: ApiScope[]) {
  const token = generateToken();
  await prisma.apiToken.create({
    data: { name, hash: hashToken(token), scopes },
  });
  return token;
}

before(async () => {
  const ws = await prisma.workspace.upsert({
    where: { id: "ws-default" },
    update: {},
    create: { id: "ws-default", name: "Mine" },
  });
  const project = await prisma.project.create({
    data: { name: "MCP project", workspaceId: ws.id },
  });
  projectId = project.id;
});

beforeEach(async () => {
  await prisma.apiToken.deleteMany({});
  liveToken = await mintToken("full", [
    "projects:read",
    "tasks:read",
    "tasks:write",
    "sandboxes:read",
    "sandboxes:write",
  ]);
  readOnlyToken = await mintToken("read", ["projects:read", "tasks:read"]);
  revokedToken = await mintToken("revoked", ["projects:read"]);
  await prisma.apiToken.update({
    where: { hash: hashToken(revokedToken) },
    data: { revokedAt: new Date() },
  });
});

// --- authentication ----------------------------------------------------------

test("a request with no token is refused", async () => {
  const res = await listTools();
  assert.equal(res.status, 401);
  assert.equal(await res.text(), "", "a 401 carries no body to learn from");
});

test("an unknown token is refused", async () => {
  assert.equal((await listTools(generateToken())).status, 401);
});

test("a revoked token stops working immediately", async () => {
  // The token is re-verified per request rather than exchanged for a session,
  // which is what makes revocation take effect at once.
  assert.equal((await listTools(revokedToken)).status, 401);
});

test("a malformed authorization header is refused, not parsed loosely", async () => {
  const res = await mcpPost(
    new NextRequest("http://localhost/api/mcp", {
      method: "POST",
      headers: { Authorization: `Basic ${liveToken}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    }),
  );
  assert.equal(res.status, 401);
});

test("every rejection looks the same from outside", async () => {
  const [absent, unknown, revoked] = await Promise.all([
    listTools(),
    listTools(generateToken()),
    listTools(revokedToken),
  ]);
  const shape = async (r: Response) => ({
    status: r.status,
    body: await r.text(),
    auth: r.headers.get("WWW-Authenticate"),
  });
  const [a, u, rv] = await Promise.all([shape(absent), shape(unknown), shape(revoked)]);
  assert.deepEqual(a, u);
  assert.deepEqual(u, rv);
});

test("a valid token is accepted", async () => {
  assert.equal((await listTools(liveToken)).status, 200);
});

// --- listing is scoped -------------------------------------------------------

test("a token sees only the tools its scopes allow", async () => {
  const body = await payload(await listTools(readOnlyToken));
  const names: string[] = body.result.tools.map((t: { name: string }) => t.name);

  assert.ok(names.includes("nexux_activity"));
  assert.ok(names.includes("nexux_list_projects"));
  // Never advertise what will always be refused.
  assert.ok(!names.includes("nexux_create_task"));
  assert.ok(!names.includes("nexux_launch_sandbox"));
});

test("a full token sees every tool", async () => {
  const body = await payload(await listTools(liveToken));
  const names: string[] = body.result.tools.map((t: { name: string }) => t.name);
  assert.ok(names.includes("nexux_launch_sandbox"));
  assert.ok(names.length >= 8);
});

// --- calling -----------------------------------------------------------------

test("a read tool returns real data", async () => {
  const body = await payload(await call("nexux_list_projects", {}, liveToken));
  const text = body.result.content[0].text;
  assert.ok(!body.result.isError, text);
  const projects = JSON.parse(text);
  assert.ok(
    projects.some((p: { id: string }) => p.id === projectId),
    "the seeded project is listed",
  );
});

test("a tool outside the token's scopes is refused without running", async () => {
  const body = await payload(
    await call(
      "nexux_launch_sandbox",
      { projectId },
      readOnlyToken, // no sandboxes:write — must not provision anything
    ),
  );
  assert.equal(body.result.isError, true);
  assert.match(body.result.content[0].text, /unknown tool/i);
  // The refusal must not confirm the tool exists by naming what it needs.
  assert.ok(!/scope/i.test(body.result.content[0].text));
  assert.equal(await prisma.sandbox.count(), 0, "nothing was provisioned");
});

test("a failure from the host reaches the client as a tool error", async () => {
  // No sandbox exists, so createTask refuses — the model should see why.
  const body = await payload(
    await call(
      "nexux_create_task",
      { projectId, sandboxId: "nope", prompt: "do a thing" },
      liveToken,
    ),
  );
  assert.equal(body.result.isError, true);
  assert.match(body.result.content[0].text, /sandbox/i);
});

test("bad arguments are reported rather than crashing the request", async () => {
  const res = await call("nexux_list_sandboxes", {}, liveToken);
  assert.equal(res.status, 200, "a bad argument is not a transport failure");
  const body = await payload(res);
  assert.equal(body.result.isError, true);
  assert.match(body.result.content[0].text, /projectId/);
});

test("an unknown tool name is an error, not a crash", async () => {
  const body = await payload(await call("nexux_rm_rf", {}, liveToken));
  assert.equal(body.result.isError, true);
});

test("using the surface records the token as used", async () => {
  await call("nexux_list_projects", {}, liveToken);
  let stamped: Date | null = null;
  for (let i = 0; i < 50 && !stamped; i++) {
    const row = await prisma.apiToken.findUnique({
      where: { hash: hashToken(liveToken) },
    });
    stamped = row?.lastUsedAt ?? null;
    if (!stamped) await new Promise((r) => setTimeout(r, 20));
  }
  assert.ok(stamped, "lastUsedAt is recorded");
});

// --- transport ---------------------------------------------------------------

test("GET says there is no event stream to open", async () => {
  const res = mcpGet();
  assert.equal(res.status, 405);
  assert.equal(res.headers.get("Allow"), "POST");
});
