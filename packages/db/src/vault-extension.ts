/**
 * Seal on write, open on read — transparently, so the code that reads
 * credentials does not change (spec 32). Result extensions apply inside
 * `include` and `select` too. Nested writes from a parent model do NOT pass
 * through these query hooks: seal those explicitly (`sealString`).
 */

import type { PrismaClient } from "./generated/prisma/client";
import { isSealed, KEY_CHECK_SETTING, openJson, openString, sealJson, sealString } from "./vault";

type Kind = "string" | "json";

/** model (client property) → sealed fields. */
export const SEALED_FIELDS: Record<string, Record<string, Kind>> = {
  cloudCredential: { data: "json" },
  projectEnvVar: { value: "string" },
  settings: { value: "string" },
  oAuthToken: { accessToken: "string", refreshToken: "string" },
  sandboxConfig: { mcpServers: "json" },
  bot: { mcpServers: "json" },
  vaultItem: { secret: "json" },
};

/** Settings rows the vault itself needs in the clear. */
const isVaultBookkeeping = (key: unknown) => typeof key === "string" && key.startsWith("vault_");

/** Only plain values are sealed: Prisma's DbNull/JsonNull sentinels and operators pass through. */
function sealValue(kind: Kind, v: unknown): unknown {
  if (v === null || v === undefined) return v;
  if (kind === "string") {
    if (typeof v === "string") return sealString(v);
    if (typeof v === "object" && v && "set" in v && typeof (v as { set: unknown }).set === "string") {
      return { set: sealString((v as { set: string }).set) };
    }
    return v;
  }
  if (isSealed(v)) return v;
  const plain =
    typeof v !== "object" || Array.isArray(v) || Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null;
  return plain ? sealJson(v) : v;
}

export function sealData(model: string, data: unknown): unknown {
  const fields = SEALED_FIELDS[model];
  if (!fields || !data || typeof data !== "object") return data;
  if (Array.isArray(data)) return data.map((d) => sealData(model, d));
  const d = data as Record<string, unknown>;
  if (model === "settings" && isVaultBookkeeping(d.key)) return data;
  const out: Record<string, unknown> = { ...d };
  for (const [field, kind] of Object.entries(fields)) {
    if (field in out) out[field] = sealValue(kind, out[field]);
  }
  return out;
}

function openValue(kind: Kind, v: unknown): unknown {
  if (kind === "string") return typeof v === "string" ? openString(v) : v;
  return openJson(v);
}

const WRITE_OPS = new Set(["create", "createMany", "createManyAndReturn", "update", "updateMany", "updateManyAndReturn", "upsert"]);

export function withVault(client: PrismaClient) {
  const result: Record<string, Record<string, { needs: Record<string, true>; compute: (r: Record<string, unknown>) => unknown }>> = {};
  for (const [model, fields] of Object.entries(SEALED_FIELDS)) {
    result[model] = {};
    for (const [field, kind] of Object.entries(fields)) {
      result[model][field] = {
        needs: { [field]: true },
        compute: (r) => openValue(kind, r[field]),
      };
    }
  }
  return client.$extends({
    name: "nexux-vault",
    result: result as never,
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }) {
          const key = model ? model.charAt(0).toLowerCase() + model.slice(1) : "";
          if (!SEALED_FIELDS[key] || !WRITE_OPS.has(operation)) return query(args);
          const a = { ...(args as Record<string, unknown>) };
          if (key === "settings" && operation !== "createMany") {
            const where = a.where as { key?: unknown } | undefined;
            const create = a.create as { key?: unknown } | undefined;
            if (isVaultBookkeeping(where?.key) || isVaultBookkeeping(create?.key)) return query(args);
          }
          if ("data" in a) a.data = sealData(key, a.data);
          if ("create" in a) a.create = sealData(key, a.create);
          if ("update" in a) a.update = sealData(key, a.update);
          return query(a as typeof args);
        },
      },
    },
  });
}

export { KEY_CHECK_SETTING };
