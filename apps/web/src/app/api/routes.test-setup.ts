// Imported by the API route tests BEFORE any route module. Routes reach
// @nexux/db, whose Prisma client is built at module load and runs migrations
// when NEXUX_MIGRATIONS_DIR is set — so both must be pointed at a throwaway
// SQLite file first. Unlike the other test-setups in this repo, the database
// here IS used: these are integration tests that drive real handlers against
// real rows.
// Not matched by the test glob (`*.test.ts`).
import fs from "fs";
import os from "os";
import path from "path";

export const testDbDir = fs.mkdtempSync(path.join(os.tmpdir(), "nexux-routes-"));

process.env.DATABASE_URL = `file:${path.join(testDbDir, "test.db")}`;
process.env.NEXUX_DATA_DIR = testDbDir;
process.env.NEXUX_MIGRATIONS_DIR = path.resolve(
  __dirname,
  "../../../../../packages/db/prisma/migrations"
);
