import fs from "fs";
import path from "path";
import { PrismaClient } from "./generated/prisma/client";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { ensureMigrated } from "./migrate";
import { databasePath } from "./db-path";
import { withVault } from "./vault-extension";
import { prepareVault, type VaultReport } from "./vault-admin";

function ensureDir(filePath: string) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function maybeMigrate(dbPath: string) {
  const dir = process.env.NEXUX_MIGRATIONS_DIR;
  if (!dir) return;
  try {
    ensureMigrated(dbPath, dir);
  } catch (err) {
    console.error("[db] auto-migrate failed:", err);
    throw err;
  }
}

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
  prismaBase: PrismaClient | undefined;
};

function createBaseClient(): PrismaClient {
  const dbPath = databasePath();
  ensureDir(dbPath);
  maybeMigrate(dbPath);
  const adapter = new PrismaBetterSqlite3({ url: dbPath });
  return new PrismaClient({ adapter });
}

// The raw client stays private: it would write secrets unsealed. Everything
// else gets the vault extension (seal on write, open on read — spec 32), which
// leaves model types unchanged, hence the cast.
const base = globalForPrisma.prismaBase ?? createBaseClient();
export const prisma = globalForPrisma.prisma ?? (withVault(base) as unknown as PrismaClient);

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
  globalForPrisma.prismaBase = base;
}

/**
 * Boot step: check the vault key against the database and seal any secret
 * still stored in plaintext. Idempotent. Throws when the key does not match
 * the data (lost or replaced key) rather than sealing over it.
 */
export function ensureVault(): Promise<VaultReport> {
  return prepareVault(base);
}
