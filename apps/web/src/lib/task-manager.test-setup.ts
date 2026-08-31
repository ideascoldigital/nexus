// Imported by task-manager.test.ts BEFORE ./task-manager. That module reaches
// prisma at import time, and the client is built when the module loads — so
// DATABASE_URL has to point somewhere before the import runs. Nothing here is
// queried; the tests only exercise the in-memory sandbox locks.
// Not matched by the test glob (`*.test.ts`).
import fs from "fs";
import os from "os";
import path from "path";

export const testDbDir = fs.mkdtempSync(
  path.join(os.tmpdir(), "nexux-task-manager-")
);
process.env.DATABASE_URL = `file:${path.join(testDbDir, "test.db")}`;
