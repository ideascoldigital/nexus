import assert from "node:assert/strict";
import fs from "node:fs";
import { after, beforeEach, test } from "node:test";

// Env setup must stay above every other import (throwaway DB → ephemeral vault key).
import { testDbDir } from "./routes.test-setup";
import { NextRequest } from "next/server";
import { prisma } from "@nexux/db";

import { GET as listVault, POST as createItem } from "./vault/route";
import { DELETE as deleteItem, PATCH as patchItem } from "./vault/[itemId]/route";
import { GET as botVault } from "./bots/[botId]/vault/route";
import { POST as botFill } from "./bots/[botId]/vault/fill/route";
import { grantVault, revokeVault } from "@/lib/bot-vault-access";

after(async () => {
  await prisma.$disconnect();
  fs.rmSync(testDbDir, { recursive: true, force: true });
});

beforeEach(async () => {
  await prisma.vaultItem.deleteMany({});
  await prisma.bot.deleteMany({});
});

const req = (url: string, method: string, body?: unknown, headers: Record<string, string> = {}) =>
  new NextRequest(`http://test${url}`, {
    method,
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: { "content-type": "application/json", ...headers },
  });
const p = <T>(v: T) => ({ params: Promise.resolve(v) });

test("vault entries: created sealed, listed without secrets, edited, deleted", async () => {
  const res = await createItem(req("/api/vault", "POST", { type: "login", websites: ["https://www.facebook.com/"], username: "me@example.com", secret: { password: "hunter2" } }));
  assert.equal(res.status, 201);
  const login = await res.json();
  assert.equal(login.name, "facebook.com");
  assert.deepEqual(login.filled, ["password"]);
  assert.equal(JSON.stringify(login).includes("hunter2"), false);

  const secret = await (await createItem(req("/api/vault", "POST", { type: "secret", name: "mongo-readonly", secret: { value: "mongodb+srv://u:p@c/" } }))).json();
  assert.equal((await createItem(req("/api/vault", "POST", { type: "secret", name: "mongo-readonly", secret: { value: "x" } }))).status, 409);
  assert.equal((await createItem(req("/api/vault", "POST", { type: "card", secret: { number: "1234", expiry: "12/29", cvc: "123", holder: "A" } }))).status, 400);

  const listed = await (await listVault()).json();
  assert.equal(listed.length, 2);
  assert.equal(JSON.stringify(listed).includes("mongodb+srv"), false);

  // At rest: sealed in the file.
  // Raw SQL skips the vault extension: this is what the file holds.
  const rows = await prisma.$queryRaw<Array<{ secret: string }>>`select CAST(secret AS TEXT) as secret from VaultItem`;
  assert.ok(rows.every((r) => r.secret.includes("$nxv") && !r.secret.includes("hunter2") && !r.secret.includes("mongodb")));

  // Blank secret fields keep the stored value; a given one replaces it.
  const kept = await (await patchItem(req(`/api/vault/${login.id}`, "PATCH", { hint: "the ads account", secret: { password: "" } }), p({ itemId: login.id }))).json();
  assert.equal(kept.hint, "the ads account");
  assert.equal(((await prisma.vaultItem.findUniqueOrThrow({ where: { id: login.id } })).secret as { password: string }).password, "hunter2");
  await patchItem(req(`/api/vault/${login.id}`, "PATCH", { secret: { password: "new-pass", bogus: "x" } }), p({ itemId: login.id }));
  assert.deepEqual((await prisma.vaultItem.findUniqueOrThrow({ where: { id: login.id } })).secret, { password: "new-pass" });

  assert.equal((await deleteItem(req(`/api/vault/${secret.id}`, "DELETE"), p({ itemId: secret.id }))).status, 200);
  assert.equal((await deleteItem(req(`/api/vault/${secret.id}`, "DELETE"), p({ itemId: secret.id }))).status, 404);
});

test("a bot reaches the vault only with a live token, only its entries, only fillable fields", async () => {
  const bot = await prisma.bot.create({ data: { name: "Ads" } });
  const other = await prisma.bot.create({ data: { name: "Other" } });
  await createItem(req("/api/vault", "POST", { type: "login", websites: ["facebook.com"], username: "me@example.com", secret: { password: "pw" }, botIds: [bot.id] }));
  await createItem(req("/api/vault", "POST", { type: "login", websites: ["x.com"], secret: { password: "pw2" }, botIds: [other.id] }));
  await createItem(req("/api/vault", "POST", { type: "secret", name: "api-key", secret: { value: "k" } }));

  const vaultOf = (token?: string) =>
    botVault(req(`/api/bots/${bot.id}/vault`, "GET", undefined, token ? { "x-nexux-vault-token": token } : {}), p({ botId: bot.id }));
  assert.equal((await vaultOf()).status, 401);

  const token = grantVault({ botId: bot.id, runId: "r1", container: "no-such-container" , dockerHost: null });
  const list = await (await vaultOf(token)).json();
  // Its own login only; secrets are for MCP configs, not for vault_fill.
  assert.deepEqual(list.map((e: { name: string }) => e.name), ["facebook.com"]);
  assert.deepEqual(list[0].fields, ["password"]);
  assert.equal(JSON.stringify(list).includes("pw"), false);

  const fill = (body: unknown, t = token) =>
    botFill(req(`/api/bots/${bot.id}/vault/fill`, "POST", body, { "x-nexux-vault-token": t }), p({ botId: bot.id }));
  assert.equal((await fill({ entry: "x.com", field: "password" })).status, 404); // not this bot's
  assert.equal((await fill({ entry: "api-key", field: "value" })).status, 400); // secrets aren't typed
  const user = await fill({ entry: "facebook.com", field: "username" });
  assert.equal(user.status, 400);
  assert.match((await user.json()).error, /type the username yourself/);

  revokeVault(token);
  assert.equal((await fill({ entry: "facebook.com", field: "password" })).status, 401);
});
