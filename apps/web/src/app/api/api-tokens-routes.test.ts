import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

// Env setup must stay above every other import — the route modules reach
// @nexux/db, whose client is built (and migrated) at module load.
import "./routes.test-setup";
import { NextRequest } from "next/server";
import { prisma } from "@nexux/db";

import {
  GET as listTokens,
  POST as createToken,
  claudeMcpAddCommand,
  mcpEndpoint,
} from "./api-tokens/route";
import { DELETE as revokeToken } from "./api-tokens/[tokenId]/route";
import { hashToken, verifyToken } from "@/lib/api-token";

const post = (body: unknown) =>
  createToken(
    new NextRequest("http://localhost/api/api-tokens", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  );

const revoke = (tokenId: string) =>
  revokeToken(new NextRequest("http://localhost/api/api-tokens/x", { method: "DELETE" }), {
    params: Promise.resolve({ tokenId }),
  });

beforeEach(async () => {
  await prisma.apiToken.deleteMany({});
});

// --- creation ----------------------------------------------------------------

test("creating a token returns the value exactly once", async () => {
  const res = await post({ name: "local claude", scopes: ["tasks:read"] });
  assert.equal(res.status, 201);
  const body = await res.json();

  assert.ok(body.token.startsWith("nxs_"), "the token is returned on creation");
  assert.equal(body.name, "local claude");
  assert.deepEqual(body.scopes, ["tasks:read"]);

  // …and never again. The list cannot carry it: only the hash is stored.
  const listed = await (await listTokens()).json();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].token, undefined);
  assert.equal(listed[0].hash, undefined);
});

test("the stored row holds the hash, not the token", async () => {
  const { token } = await (
    await post({ name: "t", scopes: ["tasks:read"] })
  ).json();
  const rows = await prisma.apiToken.findMany();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].hash, hashToken(token));
  assert.ok(!JSON.stringify(rows[0]).includes(token));
});

test("a created token immediately verifies with its scopes", async () => {
  const { token } = await (
    await post({ name: "t", scopes: ["tasks:read", "sandboxes:write"] })
  ).json();
  const verified = await verifyToken(token);
  assert.deepEqual(verified?.scopes, ["tasks:read", "sandboxes:write"]);
});

test("every token is distinct even under the same name", async () => {
  const a = await (await post({ name: "same", scopes: ["tasks:read"] })).json();
  const b = await (await post({ name: "same", scopes: ["tasks:read"] })).json();
  assert.notEqual(a.token, b.token);
  assert.notEqual(a.id, b.id);
});

// --- the connect command -----------------------------------------------------
// Creation ships a ready-made `claude mcp add` line so the token never has to
// be assembled into one by hand.

test("creation returns a command carrying the token and the endpoint", async () => {
  const body = await (
    await post({ name: "local claude", scopes: ["tasks:read"] })
  ).json();

  assert.match(body.command, /^claude mcp add nexux /);
  assert.ok(body.command.includes(body.token), "the token is in the command");
  assert.ok(body.command.includes("/api/mcp"));
  assert.ok(body.mcpUrl.endsWith("/api/mcp"));
});

test("the endpoint is built without doubling the slash", () => {
  assert.equal(mcpEndpoint("http://localhost:3000"), "http://localhost:3000/api/mcp");
  assert.equal(mcpEndpoint("http://localhost:3000/"), "http://localhost:3000/api/mcp");
  assert.equal(mcpEndpoint("http://box.ts.net:3030//"), "http://box.ts.net:3030/api/mcp");
});

test("the command survives a paste into a shell", () => {
  const cmd = claudeMcpAddCommand("http://box.ts.net:3030", "nxs_abc");
  // The header is one argument, so it has to arrive quoted — unquoted, the
  // space in "Bearer nxs_abc" would split it into two.
  assert.ok(cmd.includes(`--header 'Authorization: Bearer nxs_abc'`), cmd);
  assert.ok(cmd.includes(`'http://box.ts.net:3030/api/mcp'`), cmd);
});

test("a quote in the origin cannot break out of the quoting", () => {
  // An origin is interpolated from NEXUX_WEB_ORIGIN or a Host header, and the
  // result is a line a person pastes into their shell — the one place where
  // unescaped interpolation actually matters.
  const cmd = claudeMcpAddCommand("http://evil'; rm -rf /; echo '", "nxs_abc");
  assert.ok(!/'; rm -rf \/; echo '/.test(cmd.replace(/'\\''/g, "")), cmd);
  assert.ok(cmd.includes(`'\\''`), "the quote is escaped, not passed through");
});

// --- rejected input ----------------------------------------------------------
// A token that authenticates and can do nothing reads as broken rather than
// deliberate, so an empty scope list is refused rather than minted.

test("an unknown scope is refused", async () => {
  const res = await post({ name: "t", scopes: ["sandboxes:destroy"] });
  assert.equal(res.status, 400);
  assert.equal(await prisma.apiToken.count(), 0);
});

test("an empty scope list is refused", async () => {
  const res = await post({ name: "t", scopes: [] });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /at least one scope/i);
});

test("duplicate scopes are refused", async () => {
  const res = await post({ name: "t", scopes: ["tasks:read", "tasks:read"] });
  assert.equal(res.status, 400);
});

test("a nameless token is refused", async () => {
  assert.equal((await post({ name: "   ", scopes: ["tasks:read"] })).status, 400);
  assert.equal((await post({ scopes: ["tasks:read"] })).status, 400);
});

test("an unparseable body is refused rather than throwing", async () => {
  const res = await createToken(
    new NextRequest("http://localhost/api/api-tokens", {
      method: "POST",
      body: "not json",
    }),
  );
  assert.equal(res.status, 400);
});

// --- revocation --------------------------------------------------------------

test("revoking stops the token working but keeps the record", async () => {
  const { id, token } = await (
    await post({ name: "leaked", scopes: ["tasks:write"] })
  ).json();
  assert.ok(await verifyToken(token));

  const res = await revoke(id);
  assert.equal(res.status, 200);

  assert.equal(await verifyToken(token), null, "the token stops working");

  // The row survives: after a leak, when it was made and last used is the
  // information you actually want.
  const row = await prisma.apiToken.findUnique({ where: { id } });
  assert.ok(row, "the record is kept");
  assert.ok(row.revokedAt);
  assert.equal(row.name, "leaked");
});

test("revoking twice is not an error", async () => {
  const { id } = await (await post({ name: "t", scopes: ["tasks:read"] })).json();
  const first = await revoke(id);
  const second = await revoke(id);
  assert.equal(second.status, 200);
  // The first revocation's timestamp stands — a second call must not move it.
  assert.deepEqual(await first.json(), await second.json());
});

test("revoking an unknown token is a 404", async () => {
  assert.equal((await revoke("nope")).status, 404);
});

test("revoking one token leaves the others alone", async () => {
  const keep = await (await post({ name: "keep", scopes: ["tasks:read"] })).json();
  const drop = await (await post({ name: "drop", scopes: ["tasks:read"] })).json();

  await revoke(drop.id);

  assert.ok(await verifyToken(keep.token), "the untouched token still works");
  assert.equal(await verifyToken(drop.token), null);
});

// --- listing -----------------------------------------------------------------

test("the list reports scopes, usage and revocation", async () => {
  const { id, token } = await (
    await post({ name: "shown", scopes: ["tasks:read"] })
  ).json();
  await verifyToken(token);
  await revoke(id);

  const [listed] = await (await listTokens()).json();
  assert.equal(listed.name, "shown");
  assert.deepEqual(listed.scopes, ["tasks:read"]);
  assert.ok(listed.revokedAt);
  assert.ok(listed.createdAt);
});
