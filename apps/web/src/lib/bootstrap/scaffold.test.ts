import assert from "node:assert/strict";
import test from "node:test";
import { chmod, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { BootstrapError, scaffoldBootstrapProject } from "./scaffold";

// Commits must not depend on the machine's git identity: a host container has
// none, and the scaffold passes one inline. Pointing both config files at
// /dev/null reproduces that machine here.
process.env.GIT_CONFIG_GLOBAL = os.devNull;
process.env.GIT_CONFIG_SYSTEM = os.devNull;

async function tmpParent(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "nexux-scaffold-"));
}

test("scaffolds and commits without a global git identity", async () => {
  const parent = await tmpParent();
  try {
    const { dir, warnings } = await scaffoldBootstrapProject({
      name: "My Idea",
      type: "backend",
      parentPath: parent,
    });
    assert.equal(dir, path.join(parent, "my-idea"));
    assert.deepEqual(warnings, [], "commit should not need machine git config");
    const entries = await readdir(dir);
    assert.ok(entries.includes(".git"), "git repo initialized");
    assert.ok(entries.includes("README.md"));
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("unwritable location becomes a BootstrapError, not a bare 500", async () => {
  const parent = await tmpParent();
  try {
    await chmod(parent, 0o555);
    await assert.rejects(
      scaffoldBootstrapProject({
        name: "Blocked",
        type: "backend",
        parentPath: parent,
      }),
      (err: unknown) => {
        // The raw EACCES used to escape as an empty 500 the UI could not
        // explain; the user-facing error must name the writable root instead.
        assert.ok(err instanceof BootstrapError, `got ${err}`);
        assert.equal(err.status, 400);
        assert.match(err.message, /cannot write/i);
        return true;
      },
    );
  } finally {
    await chmod(parent, 0o755);
    await rm(parent, { recursive: true, force: true });
  }
});

test("existing non-empty directory is refused with 409", async () => {
  const parent = await tmpParent();
  try {
    await mkdir(path.join(parent, "taken", "stuff"), { recursive: true });
    await assert.rejects(
      scaffoldBootstrapProject({
        name: "Taken",
        type: "backend",
        parentPath: parent,
      }),
      (err: unknown) => {
        assert.ok(err instanceof BootstrapError, `got ${err}`);
        assert.equal(err.status, 409);
        return true;
      },
    );
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});
