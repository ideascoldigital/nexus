// Imported by client.test.ts BEFORE ./client so the env is set when the
// prisma singleton is created at module load. Not matched by the test glob.
import fs from "fs";
import os from "os";
import path from "path";

export const testDbDir = fs.mkdtempSync(path.join(os.tmpdir(), "nexux-db-"));
process.env.DATABASE_URL = `file:${path.join(testDbDir, "test.db")}`;
process.env.NEXUX_MIGRATIONS_DIR = path.resolve(
  __dirname,
  "../prisma/migrations",
);
