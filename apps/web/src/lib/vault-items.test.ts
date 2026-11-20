import assert from "node:assert/strict";
import test from "node:test";

import {
  botMayUse,
  cardLabel,
  hostMatches,
  itemFromInput,
  luhnOk,
  normalizeHost,
  resolveSecretRefs,
  secretRefs,
  toPublicItem,
  vaultCreateSchema,
} from "./vault-items";

test("websites normalize to a bare host", () => {
  assert.equal(normalizeHost("https://www.Facebook.com/login?x=1"), "facebook.com");
  assert.equal(normalizeHost("business.facebook.com"), "business.facebook.com");
  assert.equal(normalizeHost("not a site"), "");
  assert.equal(normalizeHost(""), "");
});

test("a login's fields only go to its own sites", () => {
  const sites = ["facebook.com"];
  assert.equal(hostMatches(sites, "https://www.facebook.com/login"), true);
  assert.equal(hostMatches(sites, "https://business.facebook.com/"), true);
  assert.equal(hostMatches(sites, "https://facebook.com.evil.example/"), false);
  assert.equal(hostMatches(sites, "https://notfacebook.com/"), false);
  assert.equal(hostMatches(sites, "garbage"), false);
});

test("cards: Luhn, brand and the label the list shows", () => {
  assert.equal(luhnOk("4242 4242 4242 4242"), true);
  assert.equal(luhnOk("4242 4242 4242 4241"), false);
  assert.equal(cardLabel("4242424242424242"), "Visa •••• 4242");
  assert.equal(cardLabel("5555 5555 5555 4444"), "Mastercard •••• 4444");
  assert.equal(cardLabel("378282246310005"), "Amex •••• 0005");
});

test("each type validates and becomes a row; the public view never carries the secret", () => {
  const login = vaultCreateSchema.parse({ type: "login", websites: ["https://www.facebook.com"], username: "me@example.com", secret: { password: "hunter2" } });
  const row = itemFromInput(login);
  assert.ok(row.ok);
  assert.equal(row.row.name, "facebook.com");
  assert.deepEqual(row.row.websites, ["facebook.com"]);

  const pub = toPublicItem({ ...row.row, id: "v1", lastUsedAt: null, createdAt: new Date(0), updatedAt: new Date(0) });
  assert.deepEqual(pub.filled, ["password"]);
  assert.equal(JSON.stringify(pub).includes("hunter2"), false);
  assert.equal(pub.botIds, null);

  const card = itemFromInput(
    vaultCreateSchema.parse({ type: "card", secret: { number: "4242 4242 4242 4242", expiry: "12/29", cvc: "123", holder: "Alex Doe" } }),
  );
  assert.ok(card.ok && card.row.label === "Visa •••• 4242" && (card.row.secret as { number: string }).number === "4242424242424242");

  assert.equal(vaultCreateSchema.safeParse({ type: "secret", name: "bad name", secret: { value: "x" } }).success, false);
  assert.equal(vaultCreateSchema.safeParse({ type: "card", secret: { number: "1234", expiry: "13/29", cvc: "1", holder: "" } }).success, false);
  const emptyContact = itemFromInput(vaultCreateSchema.parse({ type: "contact", name: "Office", secret: { email: " " } }));
  assert.equal(emptyContact.ok, false);
});

test("bot access: empty means every bot", () => {
  assert.equal(botMayUse({ botIds: null }, "b1"), true);
  assert.equal(botMayUse({ botIds: [] }, "b1"), true);
  assert.equal(botMayUse({ botIds: ["b2"] }, "b1"), false);
  assert.equal(botMayUse({ botIds: ["b1"] }, "b1"), true);
});

test("{{secret:name}} resolves in any string; a server missing one is dropped, not started with the placeholder", () => {
  const servers = {
    mongodb: { command: "npx", args: ["-y", "mongodb-mcp-server", "--readOnly"], env: { MDB_MCP_CONNECTION_STRING: "{{secret:mongo-readonly}}" } },
    api: { type: "http", url: "https://mcp.example.com", headers: { Authorization: "Bearer {{ secret:api-token }}" } },
    plain: { command: "npx", args: ["-y", "x"] },
  };
  assert.deepEqual(secretRefs(servers).sort(), ["api-token", "mongo-readonly"]);
  const vault: Record<string, string> = { "mongo-readonly": "mongodb+srv://u:p@c/" };
  const r = resolveSecretRefs(servers, (n) => vault[n] ?? null);
  assert.deepEqual(Object.keys(r.servers), ["mongodb", "plain"]);
  assert.equal((r.servers.mongodb as { env: Record<string, string> }).env.MDB_MCP_CONNECTION_STRING, "mongodb+srv://u:p@c/");
  assert.deepEqual(r.missing, [{ server: "api", secret: "api-token" }]);
});
