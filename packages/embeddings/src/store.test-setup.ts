// Imported by store.test.ts BEFORE ./store so NEXUX_DATA_DIR is set when
// store.ts computes INDEXES_ROOT at module load. Not matched by the test glob.
import fs from "fs";
import os from "os";
import path from "path";

export const testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "nexux-store-"));
process.env.NEXUX_DATA_DIR = testDataDir;
