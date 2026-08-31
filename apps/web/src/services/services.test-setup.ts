// Imported by the services tests BEFORE any ./<service> module. Several of
// them reach @nexux/db, which builds its Prisma client at module load and
// throws without DATABASE_URL. Nothing here is queried — the tests below only
// exercise pure parsing and formatting.
// Not matched by the test glob (`*.test.ts`).
import fs from "fs";
import os from "os";
import path from "path";

export const testDbDir = fs.mkdtempSync(
  path.join(os.tmpdir(), "nexux-services-")
);
process.env.DATABASE_URL = `file:${path.join(testDbDir, "test.db")}`;
