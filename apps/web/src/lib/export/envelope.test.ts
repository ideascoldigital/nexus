import assert from "node:assert/strict";
import { test } from "node:test";

import { PassphraseError, isEncrypted, open, safeEqual, seal } from "./envelope";

const doc = { meta: { pathRoot: "/Users/j/ws" }, secret: "sk-live-abc123" };
const PASS = "correct horse battery staple";

test("seal → open round trips the document", async () => {
  const sealed = await seal(doc, PASS);
  assert.deepEqual(await open(sealed, PASS), doc);
});

test("the sealed envelope leaks no plaintext", async () => {
  const sealed = await seal(doc, PASS);
  const serialised = JSON.stringify(sealed);
  assert.ok(!serialised.includes("sk-live-abc123"));
  // meta is inside the ciphertext too — version and scope are secrets-adjacent.
  assert.ok(!serialised.includes("/Users/j/ws"));
  assert.equal(sealed.cipher, "aes-256-gcm");
});

test("wrong passphrase fails on the auth tag, not with garbage", async () => {
  const sealed = await seal(doc, PASS);
  await assert.rejects(() => open(sealed, "wrong passphrase here"), PassphraseError);
});

test("a tampered payload is rejected", async () => {
  const sealed = await seal(doc, PASS);
  const payload = Buffer.from(sealed.payload, "base64");
  payload[0] ^= 0xff;
  await assert.rejects(
    () => open({ ...sealed, payload: payload.toString("base64") }, PASS),
    PassphraseError,
  );
});

test("each seal uses a fresh salt and iv", async () => {
  const a = await seal(doc, PASS);
  const b = await seal(doc, PASS);
  assert.notEqual(a.kdf.salt, b.kdf.salt);
  assert.notEqual(a.iv, b.iv);
  assert.notEqual(a.payload, b.payload);
});

test("kdf parameters travel with the file", async () => {
  // Stored rather than assumed, so raising the cost later still opens old files.
  const sealed = await seal(doc, PASS);
  assert.equal(sealed.kdf.name, "scrypt");
  assert.equal(sealed.kdf.N, 16384);
  assert.deepEqual(await open({ ...sealed }, PASS), doc);
});

test("an empty passphrase is refused at seal time", async () => {
  await assert.rejects(() => seal(doc, ""), PassphraseError);
});

test("open rejects something that is not an envelope", async () => {
  await assert.rejects(() => open({ meta: {}, projects: [] }, PASS), PassphraseError);
});

test("open refuses an envelope from a newer export version", async () => {
  const sealed = await seal(doc, PASS);
  await assert.rejects(
    () => open({ ...sealed, nexuxExportVersion: 99 }, PASS),
    /newer than this install supports/,
  );
});

test("isEncrypted distinguishes an envelope from a raw document", async () => {
  assert.equal(isEncrypted(await seal(doc, PASS)), true);
  assert.equal(isEncrypted({ meta: {}, projects: [] }), false);
  assert.equal(isEncrypted(null), false);
});

test("safeEqual compares without throwing on length mismatch", () => {
  assert.equal(safeEqual("abc", "abc"), true);
  assert.equal(safeEqual("abc", "abcd"), false);
  assert.equal(safeEqual("abc", "abd"), false);
});
