import { strict as assert } from "node:assert";
import { afterEach, beforeEach, test } from "node:test";
import fs from "fs/promises";
import os from "os";
import path from "path";

import { LocalFsStorage } from "./local";

let root: string;
let storage: LocalFsStorage;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "nexux-storage-"));
  storage = new LocalFsStorage(root);
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

test("write creates parent dirs; read and readText round-trip", async () => {
  await storage.write("a/b/c.txt", "hola");
  assert.equal(await storage.readText("a/b/c.txt"), "hola");
  assert.deepEqual(await storage.read("a/b/c.txt"), Buffer.from("hola"));
});

test("write accepts Buffer", async () => {
  await storage.write("bin.dat", Buffer.from([0, 1, 2]));
  assert.deepEqual(await storage.read("bin.dat"), Buffer.from([0, 1, 2]));
});

test("absolute keys bypass the root", async () => {
  const abs = path.join(root, "abs.txt");
  await storage.write(abs, "x");
  assert.equal(await storage.readText(abs), "x");
  assert.equal(await storage.readText("abs.txt"), "x");
});

test("exists reflects file presence", async () => {
  assert.equal(await storage.exists("nope.txt"), false);
  await storage.write("yes.txt", "1");
  assert.equal(await storage.exists("yes.txt"), true);
});

test("delete removes files and directories, tolerates missing", async () => {
  await storage.write("dir/f.txt", "1");
  await storage.delete("dir");
  assert.equal(await storage.exists("dir"), false);
  await storage.delete("never-existed"); // must not throw
});

test("stat reports file metadata", async () => {
  await storage.write("s.txt", "abc");
  const s = await storage.stat("s.txt");
  assert.equal(s.size, 3);
  assert.equal(s.isFile, true);
  assert.equal(s.isDirectory, false);
  assert.equal(s.isSymlink, false);
  assert.ok(s.mtime instanceof Date);
});

test("stat uses lstat: symlinks are not followed", async () => {
  await storage.write("target.txt", "t");
  await storage.symlink(path.join(root, "target.txt"), "link.txt");
  const s = await storage.stat("link.txt");
  assert.equal(s.isSymlink, true);
  assert.equal(s.isFile, false);
});

test("list returns entries; ENOENT yields empty array", async () => {
  assert.deepEqual(await storage.list("missing"), []);
  await storage.write("d/one.txt", "1");
  await storage.write("d/two.txt", "2");
  assert.deepEqual((await storage.list("d")).sort(), ["one.txt", "two.txt"]);
});

test("listDetailed distinguishes files, dirs, and symlinks", async () => {
  await storage.write("d/f.txt", "1");
  await storage.mkdir("d/sub");
  await storage.symlink(path.join(root, "d/f.txt"), "d/ln");
  const entries = await storage.listDetailed("d");
  const byName = Object.fromEntries(entries.map((e) => [e.name, e]));
  assert.equal(byName["f.txt"].isFile, true);
  assert.equal(byName["sub"].isDirectory, true);
  assert.equal(byName["ln"].isSymlink, true);
  assert.deepEqual(await storage.listDetailed("missing"), []);
});

test("symlink replaces an existing symlink", async () => {
  await storage.write("t1.txt", "1");
  await storage.write("t2.txt", "2");
  await storage.symlink(path.join(root, "t1.txt"), "ln");
  await storage.symlink(path.join(root, "t2.txt"), "ln");
  assert.equal(await storage.readText("ln"), "2");
});

test("symlink refuses to replace a non-symlink", async () => {
  await storage.write("real.txt", "keep");
  await assert.rejects(
    storage.symlink(path.join(root, "t.txt"), "real.txt"),
    /not a symlink/,
  );
  assert.equal(await storage.readText("real.txt"), "keep");
});

test("symlink creates parent dirs for the link", async () => {
  await storage.write("t.txt", "1");
  await storage.symlink(path.join(root, "t.txt"), "deep/nested/ln");
  assert.equal(await storage.readText("deep/nested/ln"), "1");
});
