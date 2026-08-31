import assert from "node:assert/strict";
import { before, test } from "node:test";

// Env setup must stay above the @nexux/db import — the client is built (and
// migrated) at module load. verifyToken is a real database round-trip on
// purpose: the interesting cases are revoked and unknown tokens, and a stub
// that returns whatever it was told to would assert nothing about either.
import "../app/api/routes.test-setup";
import { prisma } from "@nexux/db";

import {
  API_SCOPES,
  bearerFrom,
  generateToken,
  hasScope,
  hashToken,
  isApiScope,
  parseScopes,
  tokenHint,
  verifyToken,
} from "./api-token";

// --- token shape -------------------------------------------------------------

test("a generated token is prefixed and unguessably long", () => {
  const token = generateToken();
  assert.ok(token.startsWith("nxs_"), "carries the recognisable prefix");
  // 32 bytes as hex. Short enough to paste, long enough that guessing is not
  // the way in.
  assert.equal(token.length, "nxs_".length + 64);
});

test("two tokens are never the same", () => {
  const seen = new Set(Array.from({ length: 50 }, () => generateToken()));
  assert.equal(seen.size, 50);
});

test("hashing is stable, and the hash is not the token", () => {
  const token = generateToken();
  assert.equal(hashToken(token), hashToken(token));
  assert.ok(!hashToken(token).includes(token.slice(4)));
});

test("the hint reveals only the tail", () => {
  const token = "nxs_" + "a".repeat(60) + "beef";
  const hint = tokenHint(token);
  assert.equal(hint, "…beef");
  assert.ok(!hint.includes(token.slice(0, 20)));
});

// --- header parsing ----------------------------------------------------------
// A header that is almost right must not be treated as right.

test("a bearer header yields its token", () => {
  assert.equal(bearerFrom("Bearer nxs_abc"), "nxs_abc");
});

test("the scheme is case-insensitive and tolerates padding", () => {
  assert.equal(bearerFrom("  bearer   nxs_abc  "), "nxs_abc");
});

test("a missing, empty or non-bearer header yields nothing", () => {
  assert.equal(bearerFrom(null), null);
  assert.equal(bearerFrom(undefined), null);
  assert.equal(bearerFrom(""), null);
  assert.equal(bearerFrom("Basic nxs_abc"), null);
  assert.equal(bearerFrom("Bearer"), null);
  assert.equal(bearerFrom("Bearer "), null);
  // Two values is not one value.
  assert.equal(bearerFrom("Bearer a b"), null);
});

// --- scopes ------------------------------------------------------------------
// Malformed scopes must grant nothing. A token that cannot be understood is
// not a token that works.

test("known scope names are recognised", () => {
  for (const scope of API_SCOPES) assert.ok(isApiScope(scope));
});

test("an invented scope is not a scope", () => {
  assert.ok(!isApiScope("sandboxes:destroy"));
  assert.ok(!isApiScope("*"));
});

test("unknown entries are dropped rather than trusted", () => {
  assert.deepEqual(parseScopes(["tasks:read", "nope", "tasks:write"]), [
    "tasks:read",
    "tasks:write",
  ]);
});

test("scopes that are not an array grant nothing", () => {
  assert.deepEqual(parseScopes(null), []);
  assert.deepEqual(parseScopes(undefined), []);
  assert.deepEqual(parseScopes("tasks:write"), []);
  assert.deepEqual(parseScopes({ scopes: ["tasks:write"] }), []);
  assert.deepEqual(parseScopes([1, true, null]), []);
});

test("hasScope is false for a null token, not a throw", () => {
  assert.equal(hasScope(null, "tasks:read"), false);
});

test("hasScope answers only for the scope asked about", () => {
  const verified = { id: "t", name: "n", scopes: ["tasks:read"] as const };
  assert.equal(hasScope({ ...verified, scopes: ["tasks:read"] }, "tasks:read"), true);
  assert.equal(
    hasScope({ ...verified, scopes: ["tasks:read"] }, "tasks:write"),
    false,
  );
});

// --- verifyToken -------------------------------------------------------------

let liveToken: string;
let revokedToken: string;

before(async () => {
  liveToken = generateToken();
  revokedToken = generateToken();
  await prisma.apiToken.createMany({
    data: [
      {
        name: "live",
        hash: hashToken(liveToken),
        scopes: ["tasks:read", "tasks:write"],
      },
      {
        name: "revoked",
        hash: hashToken(revokedToken),
        scopes: ["sandboxes:write"],
        revokedAt: new Date("2026-08-13T00:00:00.000Z"),
      },
    ],
  });
});

test("a live token verifies with its scopes", async () => {
  const verified = await verifyToken(liveToken);
  assert.ok(verified);
  assert.equal(verified.name, "live");
  assert.deepEqual(verified.scopes, ["tasks:read", "tasks:write"]);
});

test("a revoked token is refused", async () => {
  // The row still exists — revocation is a timestamp, not a delete — so this
  // asserts the check, not the absence of the row.
  assert.equal(await verifyToken(revokedToken), null);
});

test("an unknown token is refused", async () => {
  assert.equal(await verifyToken(generateToken()), null);
});

test("a token without the prefix is refused before it reaches the database", async () => {
  assert.equal(await verifyToken(liveToken.slice(4)), null);
});

test("null and empty input are refused", async () => {
  assert.equal(await verifyToken(null), null);
  assert.equal(await verifyToken(""), null);
});

test("the stored hash is not itself accepted as a token", async () => {
  // Anyone reading the database has the hash; it must not also be the key.
  assert.equal(await verifyToken(hashToken(liveToken)), null);
});

test("using a token records that it was used", async () => {
  const fresh = generateToken();
  await prisma.apiToken.create({
    data: { name: "fresh", hash: hashToken(fresh), scopes: ["tasks:read"] },
  });

  const before = await prisma.apiToken.findUnique({
    where: { hash: hashToken(fresh) },
  });
  assert.equal(before?.lastUsedAt, null);

  await verifyToken(fresh);

  // The touch is deliberately fire-and-forget, so poll rather than assume it
  // has landed by the time verifyToken resolves.
  let stamped: Date | null = null;
  for (let i = 0; i < 50 && !stamped; i++) {
    const row = await prisma.apiToken.findUnique({
      where: { hash: hashToken(fresh) },
    });
    stamped = row?.lastUsedAt ?? null;
    if (!stamped) await new Promise((r) => setTimeout(r, 20));
  }
  assert.ok(stamped, "lastUsedAt is recorded");
});

test("a token whose scopes are malformed verifies with no powers", async () => {
  const odd = generateToken();
  await prisma.apiToken.create({
    // Written by hand or by an older version — it must degrade to powerless
    // rather than throwing or defaulting to open.
    data: { name: "odd", hash: hashToken(odd), scopes: { all: true } },
  });
  const verified = await verifyToken(odd);
  assert.ok(verified);
  assert.deepEqual(verified.scopes, []);
  assert.equal(hasScope(verified, "tasks:read"), false);
});
