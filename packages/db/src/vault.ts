/**
 * The vault's crypto and key (spec 32). Values are sealed with AES-256-GCM
 * under one 32-byte key that never lives in the database:
 *
 *   NEXUX_VAULT_KEY (base64) → ephemeral (a database under the OS temp dir:
 *   tests) → macOS login Keychain → `vault.key` (0600) next to the database
 *   (or NEXUX_VAULT_KEY_FILE).
 *
 * Sealed strings look like `nxv1:<base64(iv|tag|ciphertext)>`; sealed Json
 * columns hold `{"$nxv": "nxv1:…"}`. Anything else reads as plaintext — which
 * is what lets existing rows be sealed lazily (`sealPlaintext`).
 */

import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "crypto";
import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

import { databasePath } from "./db-path";

const PREFIX = "nxv1:";
const JSON_TAG = "$nxv";
const KEYCHAIN_SERVICE = "nexux-vault";
const KEYCHAIN_ACCOUNT = "master-key";

let cached: Buffer | null = null;

export type KeySource = "env" | "ephemeral" | "keychain" | "file";
let cachedSource: KeySource | null = null;

/** The vault key, created on first use where Nexus may create one. Cached per process. */
export function vaultKey(): Buffer {
  if (cached) return cached;
  const { key, source } = resolveKey();
  if (key.length !== 32) throw new Error("vault key must be 32 bytes");
  cached = key;
  cachedSource = source;
  return key;
}

export function vaultKeySource(): KeySource {
  vaultKey();
  return cachedSource!;
}

/** Tests: forget the cached key (and use a given one). */
export function setVaultKeyForTests(key: Buffer | null): void {
  cached = key;
  cachedSource = key ? "env" : null;
}

function resolveKey(): { key: Buffer; source: KeySource } {
  const env = process.env.NEXUX_VAULT_KEY?.trim();
  if (env) return { key: Buffer.from(env, "base64"), source: "env" };
  const explicitFile = process.env.NEXUX_VAULT_KEY_FILE?.trim();
  if (explicitFile) return keyFile(explicitFile);

  const dbPath = databasePath();
  if (isUnder(dbPath, os.tmpdir()) || isUnder(dbPath, "/tmp") || isUnder(dbPath, "/private/tmp")) {
    return { key: randomBytes(32), source: "ephemeral" };
  }

  if (process.platform === "darwin") {
    const found = keychainRead();
    if (found) return { key: found, source: "keychain" };
    const key = randomBytes(32);
    keychainWrite(key);
    return { key, source: "keychain" };
  }

  return keyFile(path.join(path.dirname(dbPath), "vault.key"));
}

/** A key file (0600), created with a fresh key when missing. */
function keyFile(file: string): { key: Buffer; source: KeySource } {
  if (fs.existsSync(file)) return { key: Buffer.from(fs.readFileSync(file, "utf8").trim(), "base64"), source: "file" };
  const key = randomBytes(32);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, key.toString("base64") + "\n", { mode: 0o600, flag: "wx" });
  return { key, source: "file" };
}

function isUnder(p: string, dir: string): boolean {
  const rel = path.relative(fs.existsSync(dir) ? fs.realpathSync(dir) : dir, realish(p));
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

function realish(p: string): string {
  const dir = path.dirname(p);
  return fs.existsSync(dir) ? path.join(fs.realpathSync(dir), path.basename(p)) : p;
}

function keychainRead(): Buffer | null {
  try {
    const out = execFileSync(
      "/usr/bin/security",
      ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", KEYCHAIN_ACCOUNT, "-w"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
    return out ? Buffer.from(out, "base64") : null;
  } catch {
    return null; // not found
  }
}

function keychainWrite(key: Buffer): void {
  // `security -i` reads its command from stdin, so the key never shows in argv (ps).
  const cmd =
    `add-generic-password -s ${KEYCHAIN_SERVICE} -a ${KEYCHAIN_ACCOUNT} -l "Nexus vault key"` +
    ` -j "Encrypts the secrets in the Nexus database. Deleting it makes them unreadable."` +
    ` -w ${key.toString("base64")}\n`;
  execFileSync("/usr/bin/security", ["-i"], { input: cmd, stdio: ["pipe", "ignore", "pipe"] });
  if (!keychainRead()) throw new Error("vault: could not save the key in the macOS Keychain");
}

// ---- Sealing -------------------------------------------------------------------

export function isSealed(v: unknown): boolean {
  if (typeof v === "string") return v.startsWith(PREFIX);
  return Boolean(v) && typeof v === "object" && !Array.isArray(v) && typeof (v as Record<string, unknown>)[JSON_TAG] === "string";
}

export function sealString(plain: string, key = vaultKey()): string {
  if (plain.startsWith(PREFIX)) return plain;
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return PREFIX + Buffer.concat([iv, c.getAuthTag(), body]).toString("base64");
}

export function openString(sealed: string, key = vaultKey()): string {
  if (!sealed.startsWith(PREFIX)) return sealed; // plaintext, not yet sealed
  const raw = Buffer.from(sealed.slice(PREFIX.length), "base64");
  const d = createDecipheriv("aes-256-gcm", key, raw.subarray(0, 12));
  d.setAuthTag(raw.subarray(12, 28));
  try {
    return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString("utf8");
  } catch {
    throw new Error("vault: a value could not be decrypted — the vault key changed or the data is damaged");
  }
}

/** A Json column's value, sealed into `{"$nxv": …}`. null stays null. */
export function sealJson(v: unknown, key = vaultKey()): unknown {
  if (v === null || v === undefined || isSealed(v)) return v;
  return { [JSON_TAG]: sealString(JSON.stringify(v), key) };
}

export function openJson(v: unknown, key = vaultKey()): unknown {
  if (!isSealed(v) || typeof v === "string") return v;
  return JSON.parse(openString((v as Record<string, string>)[JSON_TAG]!, key));
}

// ---- Key check -----------------------------------------------------------------

export const KEY_CHECK_SETTING = "vault_key_check";

/** A fingerprint of the key, safe to store: HMAC of a fixed label. */
export function keyCheck(key = vaultKey()): string {
  return createHmac("sha256", key).update("nexux-vault-key-check-v1").digest("base64url");
}
