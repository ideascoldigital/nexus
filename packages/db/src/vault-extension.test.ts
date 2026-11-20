import { strict as assert } from "node:assert";
import { randomBytes } from "node:crypto";
import { after, test } from "node:test";
import Database from "better-sqlite3";
import fs from "fs";
import path from "path";

// Env setup must stay above ./client (temp DB → an ephemeral vault key).
import { testDbDir } from "./client.test-setup";
import { ensureVault, prisma } from "./client";
import { Prisma } from "./generated/prisma/client";
import { setVaultKeyForTests, vaultKey, vaultKeySource } from "./vault";

const raw = () => new Database(path.join(testDbDir, "test.db"));

after(async () => {
  await prisma.$disconnect();
  fs.rmSync(testDbDir, { recursive: true, force: true });
});

test("a database under the temp dir gets an ephemeral key, never the Keychain", () => {
  assert.equal(vaultKeySource(), "ephemeral");
});

test("credentials are sealed in the file and open through the client, nested reads included", async () => {
  const cred = await prisma.cloudCredential.create({ data: { name: "gh", provider: "github", data: { token: "ghp_123" } } });
  assert.deepEqual(cred.data, { token: "ghp_123" });

  const db = raw();
  const stored = db.prepare("select data from CloudCredential where id = ?").get(cred.id) as { data: string };
  db.close();
  assert.equal(stored.data.includes("ghp_123"), false);
  assert.match(stored.data, /\$nxv/);

  const project = await prisma.project.create({
    data: { name: "p", repositories: { create: { name: "r", repoUrl: "https://example.com/r.git", gitCredentialId: cred.id } } },
  });
  await prisma.projectEnvVar.create({ data: { projectId: project.id, key: "API_KEY", value: "sk-live" } });
  const nested = await prisma.project.findUniqueOrThrow({
    where: { id: project.id },
    include: { envVars: true, repositories: { include: { gitCredential: { select: { data: true } } } } },
  });
  assert.equal(nested.envVars[0]!.value, "sk-live");
  assert.deepEqual(nested.repositories[0]!.gitCredential?.data, { token: "ghp_123" });

  const updated = await prisma.projectEnvVar.update({ where: { id: nested.envVars[0]!.id }, data: { value: { set: "sk-new" } } });
  assert.equal(updated.value, "sk-new");
  const db2 = raw();
  const env = db2.prepare("select value from ProjectEnvVar").get() as { value: string };
  db2.close();
  assert.match(env.value, /^nxv1:/);
});

test("Json null sentinels pass through; upsert seals both branches", async () => {
  const bot = await prisma.bot.create({ data: { name: "b", mcpServers: { x: { command: "npx", env: { K: "v" } } } } });
  assert.deepEqual(bot.mcpServers, { x: { command: "npx", env: { K: "v" } } });
  const cleared = await prisma.bot.update({ where: { id: bot.id }, data: { mcpServers: Prisma.DbNull } });
  assert.equal(cleared.mcpServers, null);

  await prisma.settings.upsert({ where: { key: "openai_api_key" }, create: { key: "openai_api_key", value: "sk-a" }, update: { value: "sk-b" } });
  await prisma.settings.upsert({ where: { key: "openai_api_key" }, create: { key: "openai_api_key", value: "sk-a" }, update: { value: "sk-b" } });
  assert.equal((await prisma.settings.findUniqueOrThrow({ where: { key: "openai_api_key" } })).value, "sk-b");
  const db = raw();
  const s = db.prepare("select value from Settings where key = 'openai_api_key'").get() as { value: string };
  db.close();
  assert.match(s.value, /^nxv1:/);
});

test("boot: plaintext rows get sealed, the key is recorded, a different key is refused", async () => {
  const db = raw();
  db.prepare(
    "insert into CloudCredential (id, workspaceId, name, provider, data, createdAt, updatedAt) values ('legacy', 'ws-default', 'old', 'civo', ?, 0, 0)",
  ).run(JSON.stringify({ token: "civo-plain" }));
  db.prepare("insert into Settings (id, key, value, isActive, createdAt, updatedAt) values ('s1', 'civo_api_key', 'plain-key', 1, 0, 0)").run();
  db.close();

  const report = await ensureVault();
  assert.equal(report.keySource, "ephemeral");
  assert.ok(report.sealed.cloudCredential! >= 1);
  assert.ok(report.sealed.settings! >= 1);

  const after = raw();
  const legacy = after.prepare("select data from CloudCredential where id = 'legacy'").get() as { data: string };
  const check = after.prepare("select value from Settings where key = 'vault_key_check'").get() as { value: string };
  after.close();
  assert.equal(legacy.data.includes("civo-plain"), false);
  assert.ok(check.value && !check.value.startsWith("nxv1:"));
  assert.deepEqual((await prisma.cloudCredential.findUniqueOrThrow({ where: { id: "legacy" } })).data, { token: "civo-plain" });
  assert.equal((await prisma.settings.findUniqueOrThrow({ where: { key: "civo_api_key" } })).value, "plain-key");

  // Second run: nothing left to seal.
  assert.deepEqual((await ensureVault()).sealed, {});

  // Someone swapped the key: refuse, change nothing.
  const original = vaultKey();
  setVaultKeyForTests(randomBytes(32));
  await assert.rejects(ensureVault(), /not the key this database was sealed with/);
  setVaultKeyForTests(original);
});

test("createMany seals every row; the vault's own settings stay in the clear", async () => {
  const project = await prisma.project.create({ data: { name: "many" } });
  await prisma.projectEnvVar.createMany({
    data: [
      { projectId: project.id, key: "A", value: "one" },
      { projectId: project.id, key: "B", value: "two" },
    ],
  });
  await prisma.settings.create({ data: { key: "vault_note", value: "clear" } });
  await prisma.settings.upsert({ where: { key: "vault_note" }, create: { key: "vault_note", value: "x" }, update: { value: "still clear" } });
  const db = raw();
  const vals = db.prepare("select value from ProjectEnvVar where projectId = ?").all(project.id) as Array<{ value: string }>;
  const note = db.prepare("select value from Settings where key = 'vault_note'").get() as { value: string };
  db.close();
  assert.ok(vals.length === 2 && vals.every((v) => v.value.startsWith("nxv1:")));
  assert.equal(note.value, "still clear");
  const read = await prisma.projectEnvVar.findMany({ where: { projectId: project.id }, orderBy: { key: "asc" } });
  assert.deepEqual(read.map((r) => r.value), ["one", "two"]);
});
