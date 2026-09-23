import { strict as assert } from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { findRunnableUnits, workspacePatterns } from "./units";

/** A throwaway repo tree. Returns its root. */
function repo(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexux-units-"));
  for (const [rel, content] of Object.entries(files)) {
    const file = path.join(root, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
  return root;
}

const PKG = JSON.stringify({ name: "x", version: "1.0.0" });

test("a plain repo is exactly one unit, its root", () => {
  // The shape everything already assumed — a single-app repo must behave
  // identically to before.
  const root = repo({ "package.json": PKG });
  return findRunnableUnits("api", root).then((units) => {
    assert.equal(units.length, 1);
    assert.equal(units[0].name, "api");
    assert.equal(units[0].workdir, "");
    assert.equal(units[0].isRoot, true);
  });
});

test("a repo with no package.json at all is still one unit", () => {
  // A Go or Python repo: coarse, not wrong.
  const root = repo({ "main.go": "package main" });
  return findRunnableUnits("svc", root).then((units) => {
    assert.equal(units.length, 1);
    assert.equal(units[0].isRoot, true);
  });
});

test("pnpm-workspace.yaml expands into its members", async () => {
  const root = repo({
    "package.json": PKG,
    "pnpm-workspace.yaml": "packages:\n  - 'apps/*'\n  - 'packages/*'\n",
    "apps/web/package.json": PKG,
    "apps/api/package.json": PKG,
    "packages/ui/package.json": PKG,
  });
  const units = await findRunnableUnits("mono", root);
  const dirs = units.map((u) => u.workdir).sort();
  assert.deepEqual(dirs, ["", "apps/api", "apps/web", "packages/ui"]);
});

test("the root is always a unit, even inside a workspace", async () => {
  // A monorepo's top-level install is what makes every member installable.
  const root = repo({
    "package.json": PKG,
    "pnpm-workspace.yaml": "packages:\n  - 'apps/*'\n",
    "apps/web/package.json": PKG,
  });
  const units = await findRunnableUnits("mono", root);
  assert.equal(units.filter((u) => u.isRoot).length, 1);
  assert.equal(units[0].workdir, "", "the root is not first");
});

test("units are named <repo>/<workdir>, so two apis do not collide", async () => {
  // A canvas with two nodes called "api" is one nobody can read.
  const root = repo({
    "package.json": PKG,
    "pnpm-workspace.yaml": "packages:\n  - 'apps/*'\n",
    "apps/api/package.json": PKG,
  });
  const units = await findRunnableUnits("mono", root);
  assert.ok(units.some((u) => u.name === "mono/apps/api"));
});

test("npm/yarn `workspaces` in package.json is read too", async () => {
  const root = repo({
    "package.json": JSON.stringify({ name: "m", workspaces: ["apps/*"] }),
    "apps/web/package.json": PKG,
  });
  const units = await findRunnableUnits("mono", root);
  assert.ok(units.some((u) => u.workdir === "apps/web"));
});

test("the object form of `workspaces` is read as well", async () => {
  const root = repo({
    "package.json": JSON.stringify({ name: "m", workspaces: { packages: ["apps/*"] } }),
    "apps/web/package.json": PKG,
  });
  const units = await findRunnableUnits("mono", root);
  assert.ok(units.some((u) => u.workdir === "apps/web"));
});

test("a directory without a package.json is not a workspace member", async () => {
  // `apps/*` matching a docs folder would put a node on the canvas for
  // something that cannot be installed or run.
  const root = repo({
    "package.json": PKG,
    "pnpm-workspace.yaml": "packages:\n  - 'apps/*'\n",
    "apps/web/package.json": PKG,
    "apps/notes/README.md": "# not a package",
  });
  const units = await findRunnableUnits("mono", root);
  assert.ok(!units.some((u) => u.workdir === "apps/notes"));
});

test("node_modules and dotfiles are never members", async () => {
  const root = repo({
    "package.json": PKG,
    "pnpm-workspace.yaml": "packages:\n  - '*'\n",
    "node_modules/evil/package.json": PKG,
    ".cache/x/package.json": PKG,
    "app/package.json": PKG,
  });
  const units = await findRunnableUnits("mono", root);
  assert.deepEqual(units.map((u) => u.workdir).sort(), ["", "app"]);
});

test("a literal path is expanded as itself", async () => {
  const root = repo({
    "package.json": PKG,
    "pnpm-workspace.yaml": "packages:\n  - 'services/api'\n",
    "services/api/package.json": PKG,
  });
  const units = await findRunnableUnits("mono", root);
  assert.ok(units.some((u) => u.workdir === "services/api"));
});

test("a pattern escaping the repo is refused", async () => {
  // `..` or an absolute path would scan somewhere this has no business
  // reading, and a workspace file is checked-in content like any other.
  const root = repo({
    "package.json": PKG,
    "pnpm-workspace.yaml": "packages:\n  - '../../../etc'\n  - '/etc'\n  - '!private'\n",
  });
  const units = await findRunnableUnits("mono", root);
  assert.deepEqual(units.map((u) => u.workdir), [""]);
});

test("comments and quoting in the workspace file are tolerated", async () => {
  const root = repo({
    "package.json": PKG,
    "pnpm-workspace.yaml":
      "# our packages\npackages:\n  - \"apps/*\"   # the apps\n  - 'libs/*'\n",
    "apps/web/package.json": PKG,
    "libs/ui/package.json": PKG,
  });
  const units = await findRunnableUnits("mono", root);
  assert.deepEqual(units.map((u) => u.workdir).sort(), ["", "apps/web", "libs/ui"]);
});

test("workspacePatterns returns [] for a repo that declares none", async () => {
  const root = repo({ "package.json": PKG });
  assert.deepEqual(await workspacePatterns(root), []);
});

test("a malformed workspace file does not throw", async () => {
  // It is checked-in content; a parser that fails loudly on it would make the
  // seed unusable for the repo that needs it most.
  const root = repo({
    "package.json": PKG,
    "pnpm-workspace.yaml": "packages: this is not a list\n",
  });
  const units = await findRunnableUnits("mono", root);
  assert.deepEqual(units.map((u) => u.workdir), [""]);
});

test("a missing directory answers with the root rather than throwing", async () => {
  const units = await findRunnableUnits("gone", "/nope/not/here");
  assert.equal(units.length, 1);
  assert.equal(units[0].isRoot, true);
});
