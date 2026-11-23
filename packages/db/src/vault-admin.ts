/**
 * Boot-time vault upkeep (spec 32), on the raw (unextended) client so it can
 * tell sealed rows from plaintext ones:
 *
 * 1. Key check — `Settings["vault_key_check"]` must match the key in use. With
 *    no check yet, every sealed value must open with this key; one that does
 *    not means the key that sealed it is gone: refuse, instead of sealing new
 *    data with a different key.
 * 2. Seal plaintext — every sealed field still holding plaintext is rewritten
 *    sealed. This is the migration of existing credentials; idempotent.
 */

import type { PrismaClient } from "./generated/prisma/client";
import { isSealed, KEY_CHECK_SETTING, keyCheck, openJson, openString, sealJson, sealString, vaultKeySource, type KeySource } from "./vault";
import { SEALED_FIELDS } from "./vault-extension";

export type VaultReport = { keySource: KeySource; sealed: Record<string, number> };

type Delegate = {
  findMany(args: unknown): Promise<Array<Record<string, unknown>>>;
  update(args: unknown): Promise<unknown>;
};

export async function prepareVault(db: PrismaClient): Promise<VaultReport> {
  const keySource = vaultKeySource();
  const client = db as unknown as Record<string, Delegate>;

  const stored = await db.settings.findUnique({ where: { key: KEY_CHECK_SETTING } });
  if (stored) {
    if (stored.value !== keyCheck()) {
      throw new Error(
        `vault: the key in use (${keySource}) is not the key this database was sealed with. ` +
          "Restore the original key (macOS Keychain item \"nexux-vault\", or NEXUX_VAULT_KEY / vault.key) — nothing was changed.",
      );
    }
  } else {
    for (const [model, fields] of Object.entries(SEALED_FIELDS)) {
      // Sealed values without a recorded key: fine if this key opens them
      // (sealed by this process before the first check), fatal otherwise.
      const rows = await client[model]!.findMany({ select: Object.fromEntries(Object.keys(fields).map((f) => [f, true])) });
      for (const r of rows) {
        for (const [f, kind] of Object.entries(fields)) {
          if (!isSealed(r[f])) continue;
          try {
            if (kind === "string") openString(r[f] as string);
            else openJson(r[f]);
          } catch {
            throw new Error(
              "vault: this database has sealed secrets the key in use cannot open, and no record of their key. " +
                "Restore the original key — nothing was changed.",
            );
          }
        }
      }
    }
    await db.settings.create({ data: { key: KEY_CHECK_SETTING, value: keyCheck() } });
  }

  const sealed: Record<string, number> = {};
  for (const [model, fields] of Object.entries(SEALED_FIELDS)) {
    const select: Record<string, true> = { id: true };
    for (const f of Object.keys(fields)) select[f] = true;
    if (model === "settings") select.key = true;
    const rows = await client[model]!.findMany({ select });
    let n = 0;
    for (const row of rows) {
      if (model === "settings" && typeof row.key === "string" && row.key.startsWith("vault_")) continue;
      const data: Record<string, unknown> = {};
      for (const [f, kind] of Object.entries(fields)) {
        const v = row[f];
        if (v === null || v === undefined || isSealed(v)) continue;
        data[f] = kind === "string" ? (typeof v === "string" ? sealString(v) : v) : sealJson(v);
      }
      if (Object.keys(data).length === 0) continue;
      await client[model]!.update({ where: { id: row.id }, data });
      n++;
    }
    if (n) sealed[model] = n;
  }
  return { keySource, sealed };
}
