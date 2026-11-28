import assert from "node:assert/strict";
import { test } from "node:test";

import { cleanSandboxPath, parseListing } from "./sandbox-files";

test("only absolute, clean paths reach the sandbox", () => {
  assert.equal(cleanSandboxPath(null), "/opt/nexus");
  assert.equal(cleanSandboxPath("/opt/nexus/api/../web"), "/opt/nexus/web");
  assert.equal(cleanSandboxPath("relative/path"), null);
  assert.equal(cleanSandboxPath("/opt/\0x"), null);
});

test("a listing puts folders first, then names", () => {
  assert.deepEqual(parseListing("f\t12\tREADME.md\nd\t4096\tsrc\nd\t4096\t.git\n"), [
    { name: ".git", dir: true, size: 4096 },
    { name: "src", dir: true, size: 4096 },
    { name: "README.md", dir: false, size: 12 },
  ]);
});
