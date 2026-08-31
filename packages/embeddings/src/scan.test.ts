import { strict as assert } from "node:assert";
import { afterEach, beforeEach, test } from "node:test";
import fs from "fs";
import os from "os";
import path from "path";

import { scanRepo } from "./scan";

let root: string;

function write(rel: string, content: string | Buffer = "x") {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

function rels(): string[] {
  return scanRepo(root)
    .map((f) => f.relativePath)
    .sort();
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "nexux-scan-"));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

test("missing root returns empty array", () => {
  assert.deepEqual(scanRepo(path.join(root, "nope")), []);
});

test("only text extensions are picked up", () => {
  write("a.ts");
  write("b.md");
  write("img.png");
  write("bin.exe");
  write("Makefile");
  assert.deepEqual(rels(), ["a.ts", "b.md"]);
});

test("hard-excluded directories are skipped", () => {
  write("src/ok.ts");
  write("node_modules/pkg/index.js");
  write(".git/config.json");
  write("dist/out.js");
  write(".nexux/state.json");
  assert.deepEqual(rels(), [path.join("src", "ok.ts")]);
});

test(".gitignore and .nexuxignore are honored", () => {
  write(".gitignore", "ignored-dir/\nsecret.ts\n");
  write(".nexuxignore", "private.md\n");
  write("keep.ts");
  write("secret.ts");
  write("private.md");
  write("ignored-dir/inner.ts");
  const found = rels();
  assert.ok(found.includes("keep.ts"));
  assert.ok(!found.includes("secret.ts"));
  assert.ok(!found.includes("private.md"));
  assert.ok(!found.some((f) => f.startsWith("ignored-dir")));
});

test("files over 512KB are skipped", () => {
  write("small.ts", "a".repeat(1024));
  write("big.ts", Buffer.alloc(513 * 1024, 97));
  assert.deepEqual(rels(), ["small.ts"]);
});

test("scanned entries carry absolute path and size", () => {
  write("dir/f.ts", "hello");
  const [f] = scanRepo(root);
  assert.equal(f.absolutePath, path.join(root, "dir", "f.ts"));
  assert.equal(f.relativePath, path.join("dir", "f.ts"));
  assert.equal(f.size, 5);
});
