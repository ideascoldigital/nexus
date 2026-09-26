import path from "path";
import fs from "fs";
import { getConfig } from "@nexux/config";
import { PrismaClient } from "./generated/prisma/client";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { ensureMigrated } from "./migrate";

function resolveSqlitePath(url: string): string {
  const filePath = url.slice("file:".length);
  return path.isAbsolute(filePath)
    ? filePath
    : path.resolve(process.cwd(), filePath);
}

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
};

/** Absolute path of the SQLite file DATABASE_URL names. */
export function databasePath(): string {
  const url = getConfig().databaseUrl;
  if (!url.startsWith("file:")) {
    throw new Error(`Unsupported DATABASE_URL scheme: ${url}`);
  }
  return resolveSqlitePath(url);
}

function createPrismaClient(): PrismaClient {
  const dbPath = databasePath();
  ensureDir(dbPath);
  maybeMigrate(dbPath);
  const adapter = new PrismaBetterSqlite3({ url: dbPath });
  return new PrismaClient({ adapter });
}

export const prisma = globalForPrisma.prisma ?? createPrismaClient();

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;
