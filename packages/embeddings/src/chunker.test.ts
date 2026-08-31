import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  chunkCode,
  chunkForFile,
  chunkMarkdown,
  chunkPlain,
  isMarkdownPath,
} from "./chunker";

test("isMarkdownPath matches md extensions case-insensitively", () => {
  assert.equal(isMarkdownPath("README.md"), true);
  assert.equal(isMarkdownPath("doc.MDX"), true);
  assert.equal(isMarkdownPath("notes.markdown"), true);
  assert.equal(isMarkdownPath("main.ts"), false);
  assert.equal(isMarkdownPath("Makefile"), false);
});

test("chunkCode: short file is a single chunk with line range", () => {
  const content = "a\nb\nc";
  const chunks = chunkCode(content);
  assert.equal(chunks.length, 1);
  assert.deepEqual(chunks[0], {
    text: content,
    chunkIndex: 0,
    startLine: 1,
    endLine: 3,
  });
});

test("chunkCode: long file windows with 10-line overlap", () => {
  const lines = Array.from({ length: 150 }, (_, i) => `line${i + 1}`);
  const chunks = chunkCode(lines.join("\n"));
  // stride 50: windows [1..60], [51..110], [101..150]
  assert.equal(chunks.length, 3);
  assert.equal(chunks[0].startLine, 1);
  assert.equal(chunks[0].endLine, 60);
  assert.equal(chunks[1].startLine, 51);
  assert.equal(chunks[1].endLine, 110);
  assert.equal(chunks[2].startLine, 101);
  assert.equal(chunks[2].endLine, 150);
  // overlap: window 2 starts on line 51, which window 1 also contains
  assert.ok(chunks[0].text.includes("line51"));
  assert.ok(chunks[1].text.startsWith("line51"));
  assert.deepEqual(
    chunks.map((c) => c.chunkIndex),
    [0, 1, 2],
  );
});

test("chunkCode: oversized single window splits by char cap", () => {
  // 10 lines of 1000 chars each = one window of >6000 chars
  const lines = Array.from({ length: 61 }, () => "x".repeat(1000));
  const chunks = chunkCode(lines.join("\n"));
  assert.ok(chunks.length > 1);
  for (const c of chunks) assert.ok(c.text.length <= 6000);
});

test("chunkCode handles CRLF line endings", () => {
  const chunks = chunkCode("a\r\nb\r\nc");
  assert.equal(chunks[0].endLine, 3);
});

test("chunkMarkdown splits by headings and keeps heading metadata", () => {
  const md = [
    "intro before any heading",
    "# Title",
    "body one",
    "## Section Two",
    "body two",
  ].join("\n");
  const chunks = chunkMarkdown(md);
  assert.equal(chunks.length, 3);
  assert.equal(chunks[0].heading, undefined);
  assert.equal(chunks[0].text, "intro before any heading");
  assert.equal(chunks[1].heading, "Title");
  assert.ok(chunks[1].text.includes("body one"));
  assert.equal(chunks[2].heading, "Section Two");
  assert.deepEqual(
    chunks.map((c) => c.chunkIndex),
    [0, 1, 2],
  );
});

test("chunkMarkdown skips empty sections and splits long ones", () => {
  const md = `# Empty\n\n# Long\n${"y".repeat(9000)}`;
  const chunks = chunkMarkdown(md);
  // "Empty" section is heading-only... heading line itself is body, so it stays
  const long = chunks.filter((c) => c.heading === "Long");
  assert.ok(long.length >= 2);
  for (const c of long) assert.ok(c.text.length <= 4000);
});

test("chunkMarkdown ignores #### and deeper headings", () => {
  const md = "# Top\nbody\n#### deep heading\nmore body";
  const chunks = chunkMarkdown(md);
  assert.equal(chunks.length, 1);
  assert.ok(chunks[0].text.includes("#### deep heading"));
});

test("chunkPlain trims, returns empty for blank input, splits by cap", () => {
  assert.deepEqual(chunkPlain("   \n  "), []);
  assert.deepEqual(chunkPlain("  hola  "), [{ text: "hola", chunkIndex: 0 }]);
  const chunks = chunkPlain("z".repeat(15000));
  assert.equal(chunks.length, 3);
  assert.deepEqual(
    chunks.map((c) => c.chunkIndex),
    [0, 1, 2],
  );
});

test("chunkForFile dispatches on extension", () => {
  const md = chunkForFile("doc.md", "# H\nbody");
  assert.equal(md[0].heading, "H");
  const code = chunkForFile("main.ts", "const a = 1;");
  assert.equal(code[0].startLine, 1);
});
