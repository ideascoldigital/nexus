// Imported by host-ssh.test.ts BEFORE the module under test. `ensureHostSshAccess`
// writes ~/.ssh/config and generates a keypair under dataDir, both resolved
// through @nexux/config at call time — so HOME and NEXUX_DATA_DIR must point at
// throwaway dirs before anything reads them.
// Not matched by the test glob (`*.test.ts`).
import fs from "fs";
import os from "os";
import path from "path";

export const testHomeDir = fs.mkdtempSync(
  path.join(os.tmpdir(), "nexux-host-ssh-home-"),
);
export const testDataDir = fs.mkdtempSync(
  path.join(os.tmpdir(), "nexux-host-ssh-data-"),
);

process.env.HOME = testHomeDir;
process.env.NEXUX_DATA_DIR = testDataDir;
