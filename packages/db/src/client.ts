import fs from "fs";
import path from "path";
import { PrismaClient } from "./generated/prisma/client";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { ensureMigrated } from "./migrate";
import { databasePath } from "./db-path";

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

function createPrismaClient(): PrismaClient {
  const dbPath = databasePath();
  ensureDir(dbPath);
  maybeMigrate(dbPath);
  const adapter = new PrismaBetterSqlite3({ url: dbPath });
  return new PrismaClient({ adapter });
}

export const prisma = globalForPrisma.prisma ?? createPrismaClient();

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;
