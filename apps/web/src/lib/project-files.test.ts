import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  CHAT_CHUNK_BYTES,
  editProjectFile,
  isSecretFile,
  listProjectDir,
  ProjectFileError,
  readProjectFile,
  readProjectFileLines,
  writeProjectFile,
} from "./project-files";

function repo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexux-files-"));
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "caja.pine"), "//@version=5\nindicator('caja')\n");
  fs.writeFileSync(path.join(root, ".env"), "SECRET=1");
  fs.writeFileSync(path.join(root, ".env.example"), "SECRET=");
  fs.writeFileSync(path.join(root, "bin.dat"), Buffer.from([1, 0, 2]));
  return root;
}

test("secrets are recognised; examples and ordinary files are not", () => {
  for (const p of [".env", ".env.local", "config/.env.production", "id_rsa", "server.pem", ".git/config", "credentials.json", "infra/terraform.tfstate"]) {
    assert.equal(isSecretFile(p), true, p);
  }
  for (const p of [".env.example", "id_rsa.pub", "src/index.ts", "caja.pine", "README.md"]) {
    assert.equal(isSecretFile(p), false, p);
  }
});

test("a listing marks secrets and puts folders first", async () => {
  const root = repo();
  const { entries } = await listProjectDir(root, ".");
  assert.equal(entries[0]!.name, "src");
  assert.equal(entries.find((e) => e.name === ".env")?.secret, true);
  assert.equal(entries.find((e) => e.name === "caja.pine")?.secret, undefined);
});

test("a text file is read; a secret, a binary or a path outside is not", async () => {
  const root = repo();
  const read = await readProjectFile(root, "caja.pine");
  assert.ok((read as { content?: string }).content?.includes("indicator"));
  assert.ok("binary" in (await readProjectFile(root, "bin.dat")));
  await assert.rejects(readProjectFile(root, ".env"), ProjectFileError);
  await assert.rejects(readProjectFile(root, "../../etc/hosts"), ProjectFileError);
  await assert.rejects(readProjectFile(root, "/etc/hosts"), ProjectFileError);
});

test("a symlink out of the repository is refused", async () => {
  const root = repo();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "nexux-out-"));
  fs.writeFileSync(path.join(outside, "x.txt"), "x");
  fs.symlinkSync(path.join(outside, "x.txt"), path.join(root, "link.txt"));
  await assert.rejects(readProjectFile(root, "link.txt"), /outside the project/);
});

test("a big file is read in chat-sized, numbered chunks that say where to go on", async () => {
  const root = repo();
  fs.writeFileSync(path.join(root, "big.txt"), Array.from({ length: 3000 }, (_, i) => `line ${i + 1} ${"x".repeat(40)}`).join("\n"));
  type Chunk = { fromLine: number; toLine: number; next?: string; content: string };
  const first = (await readProjectFileLines(root, "big.txt")) as Chunk;
  assert.ok(first.fromLine === 1 && first.toLine < 3000 && first.next);
  assert.ok(Buffer.byteLength(first.content) <= CHAT_CHUNK_BYTES + 200);
  assert.ok(first.content.startsWith("1\tline 1 "));
  const second = (await readProjectFileLines(root, "big.txt", first.toLine + 1)) as Chunk;
  assert.equal(second.fromLine, first.toLine + 1);
});

test("edits replace exact text once, or everywhere when asked; ambiguity and secrets are refused", async () => {
  const root = repo();
  fs.writeFileSync(path.join(root, "a.pine"), "input('Border Width')\ninput('Color')\ninput('Color')\n");
  await editProjectFile(root, "a.pine", "Border Width", "Grosor del borde");
  await assert.rejects(editProjectFile(root, "a.pine", "Color", "Colour"), /appears 2 times/);
  assert.deepEqual(await editProjectFile(root, "a.pine", "'Color'", "'Color de la línea'", true), { path: "a.pine", replaced: 2 });
  assert.equal(fs.readFileSync(path.join(root, "a.pine"), "utf8"), "input('Grosor del borde')\ninput('Color de la línea')\ninput('Color de la línea')\n");
  await assert.rejects(editProjectFile(root, "a.pine", "nope", "x"), /not found/);
  await assert.rejects(editProjectFile(root, ".env", "SECRET", "X"), /secrets/);
});

test("writes create files and folders inside the project, never outside or through a symlink out", async () => {
  const root = repo();
  assert.equal((await writeProjectFile(root, "docs/new/notes.md", "hola")).created, true);
  assert.equal(fs.readFileSync(path.join(root, "docs/new/notes.md"), "utf8"), "hola");
  await assert.rejects(writeProjectFile(root, "../escape.txt", "x"), /outside/);
  await assert.rejects(writeProjectFile(root, ".git/hooks/pre-commit", "x"), /secrets/);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "nexux-out-"));
  fs.symlinkSync(outside, path.join(root, "out"));
  await assert.rejects(writeProjectFile(root, "out/x.txt", "x"), /outside/);
  assert.equal(fs.existsSync(path.join(outside, "x.txt")), false);
});
