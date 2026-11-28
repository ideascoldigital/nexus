import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { scanDirectory } from "./repo-scan";

function tree(dirs: string[]) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "repo-scan-"));
  for (const d of dirs) fs.mkdirSync(path.join(root, d), { recursive: true });
  return root;
}

test("a wrapper repo lists the repos inside it, marked as such", async () => {
  const root = tree([".git", "api/.git", "ui/.git", "docs"]);
  const res = await scanDirectory(root);
  const byName = Object.fromEntries(res!.repos.map((r) => [r.name, r]));
  assert.equal(byName[path.basename(root)]?.containsRepos, 2);
  assert.equal(byName.api?.insideRepo, path.basename(root));
  assert.equal(byName.ui?.insideRepo, path.basename(root));
  assert.equal(byName.docs, undefined);
});

test("a plain repo is just itself", async () => {
  const root = tree([".git", "src/lib"]);
  const res = await scanDirectory(root);
  assert.equal(res!.repos.length, 1);
  assert.equal(res!.repos[0]!.containsRepos, undefined);
});

test("a folder of repos finds them two levels down", async () => {
  const root = tree(["a/.git", "group/b/.git", "group/deep/c/d/.git"]);
  const names = (await scanDirectory(root))!.repos.map((r) => r.name);
  assert.deepEqual(names, ["a", "b"]);
});
