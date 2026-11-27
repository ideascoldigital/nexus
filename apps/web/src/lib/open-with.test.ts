import assert from "node:assert/strict";
import { test } from "node:test";

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { availableOpeners, editorCommand, iconFileIn, openFileCommand } from "./open-with";

test("editors open the folder as one argument, never through a shell", () => {
  assert.deepEqual(editorCommand("cursor", "/Users/x/a b", "darwin"), ["open", "-a", "Cursor", "/Users/x/a b"]);
  assert.deepEqual(editorCommand("vscode", "/home/x/p", "linux"), ["code", "/home/x/p"]);
});

test("Finder is always offered", () => {
  assert.equal(availableOpeners("darwin", "/nonexistent-home")[0], "finder");
});

test("an app's icon is its CFBundleIconFile, with or without .icns, else the app's name", () => {
  const bundle = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "nexux-icon-")), "Code.app");
  const res = path.join(bundle, "Contents", "Resources");
  fs.mkdirSync(res, { recursive: true });
  fs.writeFileSync(path.join(res, "Code.icns"), "");
  assert.equal(iconFileIn(bundle, "Code"), path.join(res, "Code.icns"));
  assert.equal(iconFileIn(bundle, "Code.icns"), path.join(res, "Code.icns"));
  assert.equal(iconFileIn(bundle, null), path.join(res, "Code.icns"));
  fs.unlinkSync(path.join(res, "Code.icns"));
  assert.equal(iconFileIn(bundle, "Code"), null);
});

test("a file opens at its line in VS Code / Cursor, revealed in Finder", () => {
  assert.deepEqual(openFileCommand("vscode", "/Users/x/a b.ts", { line: 4, column: 2 }, "darwin"), ["open", "vscode://file/Users/x/a%20b.ts:4:2"]);
  assert.deepEqual(openFileCommand("cursor", "/Users/x/a.ts", {}, "darwin"), ["open", "cursor://file/Users/x/a.ts"]);
  assert.deepEqual(openFileCommand("finder", "/Users/x/a.ts", {}, "darwin"), ["open", "-R", "/Users/x/a.ts"]);
  assert.deepEqual(openFileCommand("vscode", "/home/x/a.ts", { line: 9 }, "linux"), ["code", "-g", "/home/x/a.ts:9"]);
});
