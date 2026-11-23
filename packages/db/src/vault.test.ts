import { strict as assert } from "node:assert";
import { randomBytes } from "node:crypto";
import { test } from "node:test";

import { isSealed, keyCheck, openJson, openString, sealJson, sealString } from "./vault";

const key = randomBytes(32);
const other = randomBytes(32);

test("a string seals and opens, with a fresh IV each time", () => {
  const a = sealString("ghp_secret", key);
  const b = sealString("ghp_secret", key);
  assert.match(a, /^nxv1:/);
  assert.notEqual(a, b);
  assert.equal(openString(a, key), "ghp_secret");
  assert.equal(sealString(a, key), a); // already sealed: unchanged
});

test("plaintext reads through, so rows can be sealed later", () => {
  assert.equal(openString("not sealed", key), "not sealed");
  assert.deepEqual(openJson({ token: "x" }, key), { token: "x" });
  assert.equal(isSealed("x"), false);
  assert.equal(isSealed({ token: "x" }), false);
});

test("Json values seal into {$nxv} and round-trip", () => {
  const v = { accessKeyId: "AKIA", secretAccessKey: "s", nested: [1, { a: true }] };
  const s = sealJson(v, key);
  assert.equal(isSealed(s), true);
  assert.equal(JSON.stringify(s).includes("AKIA"), false);
  assert.deepEqual(openJson(s, key), v);
  assert.equal(sealJson(null, key), null);
  assert.equal(sealJson(s, key), s);
});

test("a wrong key fails loudly instead of returning garbage", () => {
  const s = sealString("x", key);
  assert.throws(() => openString(s, other), /could not be decrypted/);
  assert.notEqual(keyCheck(key), keyCheck(other));
  assert.equal(keyCheck(key), keyCheck(key));
});

test("the key comes from NEXUX_VAULT_KEY, else a key file created 0600 and reused", async () => {
  const { setVaultKeyForTests, vaultKey, vaultKeySource } = await import("./vault");
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const saved = { key: process.env.NEXUX_VAULT_KEY, file: process.env.NEXUX_VAULT_KEY_FILE };
  try {
    const k = randomBytes(32);
    process.env.NEXUX_VAULT_KEY = k.toString("base64");
    setVaultKeyForTests(null);
    assert.deepEqual(vaultKey(), k);
    assert.equal(vaultKeySource(), "env");

    delete process.env.NEXUX_VAULT_KEY;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nexux-vault-"));
    process.env.NEXUX_VAULT_KEY_FILE = path.join(dir, "keys", "vault.key");
    setVaultKeyForTests(null);
    const created = vaultKey();
    assert.equal(vaultKeySource(), "file");
    assert.equal(fs.statSync(process.env.NEXUX_VAULT_KEY_FILE).mode & 0o777, 0o600);
    setVaultKeyForTests(null);
    assert.deepEqual(vaultKey(), created); // read back, not regenerated
    fs.rmSync(dir, { recursive: true, force: true });
  } finally {
    if (saved.key === undefined) delete process.env.NEXUX_VAULT_KEY;
    else process.env.NEXUX_VAULT_KEY = saved.key;
    if (saved.file === undefined) delete process.env.NEXUX_VAULT_KEY_FILE;
    else process.env.NEXUX_VAULT_KEY_FILE = saved.file;
    setVaultKeyForTests(null);
  }
});
