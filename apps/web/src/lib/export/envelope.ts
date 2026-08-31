/**
 * Passphrase encryption for exports that carry secrets.
 *
 * Context that makes this necessary: `ENCRYPTION_KEY` is read in
 * `@nexux/config` and never consumed — there is no cipher anywhere in the app,
 * so `ProjectEnvVar.value`, `CloudCredential.data` and `Settings.value` sit in
 * the SQLite file as plaintext despite schema comments claiming otherwise.
 *
 * That is a separate problem to fix. What this module refuses to do is make it
 * worse: a *file* travels in ways a database does not (chat, email, a synced
 * folder), so an export carrying secrets is sealed before it leaves the
 * process. This is transport encryption for the artifact, not encryption at
 * rest for the database.
 *
 * scrypt + aes-256-gcm from `node:crypto` — no new dependency. GCM means a
 * wrong passphrase fails on the auth tag rather than yielding plausible
 * garbage.
 */

import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scrypt as scryptCb,
  timingSafeEqual,
} from "crypto";
import { promisify } from "util";

import {
  EXPORT_VERSION,
  encryptedEnvelopeSchema,
  type EncryptedEnvelope,
} from "./schema";

const scrypt = promisify(scryptCb) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem?: number },
) => Promise<Buffer>;

/** scrypt cost parameters — read back from the envelope, not assumed. */
type KdfParams = { N: number; r: number; p: number };

/**
 * Interactive-login scrypt parameters (~100ms, ~16MB). Stored in the envelope
 * rather than assumed, so raising them later still opens old files.
 */
const KDF: KdfParams = { N: 16384, r: 8, p: 1 };
/** Node's default maxmem (32MB) sits too close to 128*N*r; ask for headroom. */
const MAXMEM = 64 * 1024 * 1024;
const KEY_BYTES = 32;
const IV_BYTES = 12;
const SALT_BYTES = 16;

export class PassphraseError extends Error {
  constructor(message = "Wrong passphrase, or the file has been altered") {
    super(message);
    this.name = "PassphraseError";
  }
}

function deriveKey(passphrase: string, salt: Buffer, params: KdfParams) {
  return scrypt(passphrase, salt, KEY_BYTES, { ...params, maxmem: MAXMEM });
}

/** JSON → sealed envelope. */
export async function seal(
  document: unknown,
  passphrase: string,
): Promise<EncryptedEnvelope> {
  if (!passphrase) throw new PassphraseError("A passphrase is required");

  const salt = randomBytes(SALT_BYTES);
  const iv = randomBytes(IV_BYTES);
  const key = await deriveKey(passphrase, salt, KDF);

  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const payload = Buffer.concat([
    cipher.update(JSON.stringify(document), "utf8"),
    cipher.final(),
  ]);

  return {
    nexuxExportVersion: EXPORT_VERSION,
    encrypted: true,
    kdf: { name: "scrypt", ...KDF, salt: salt.toString("base64") },
    cipher: "aes-256-gcm",
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    payload: payload.toString("base64"),
  };
}

/**
 * Sealed envelope → JSON. Throws `PassphraseError` for a bad passphrase or a
 * tampered payload — GCM cannot tell those apart, and neither should the
 * message shown to the user.
 */
export async function open(
  envelope: unknown,
  passphrase: string,
): Promise<unknown> {
  const parsed = encryptedEnvelopeSchema.safeParse(envelope);
  if (!parsed.success) throw new PassphraseError("Not a Nexus encrypted export");
  const env = parsed.data;

  if (env.nexuxExportVersion > EXPORT_VERSION) {
    throw new PassphraseError(
      `Export version ${env.nexuxExportVersion} is newer than this install supports (${EXPORT_VERSION})`,
    );
  }

  const key = await deriveKey(passphrase, Buffer.from(env.kdf.salt, "base64"), {
    N: env.kdf.N,
    r: env.kdf.r,
    p: env.kdf.p,
  });

  const decipher = createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(env.iv, "base64"),
  );
  decipher.setAuthTag(Buffer.from(env.tag, "base64"));

  try {
    const plain = Buffer.concat([
      decipher.update(Buffer.from(env.payload, "base64")),
      decipher.final(),
    ]);
    return JSON.parse(plain.toString("utf8"));
  } catch {
    throw new PassphraseError();
  }
}

/** True when the value looks like a sealed envelope rather than a raw document. */
export function isEncrypted(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { encrypted?: unknown }).encrypted === true
  );
}

/**
 * Constant-time string compare, for callers checking a passphrase against a
 * known value. Not used by seal/open (GCM already authenticates); exported
 * because an import UI that pre-checks a passphrase should not leak its length
 * through timing.
 */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}
