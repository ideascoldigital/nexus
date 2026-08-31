import assert from "node:assert/strict";
import test from "node:test";

import { mergeEnv, parseDotenv, parseDotenvWithDiagnostics } from "./dotenv";

test("reads plain key=value pairs", () => {
  assert.deepEqual(parseDotenv("FOO=bar\nBAZ=qux"), [
    { key: "FOO", value: "bar" },
    { key: "BAZ", value: "qux" },
  ]);
});

test("skips comments and blank lines", () => {
  const parsed = parseDotenv(
    ["# a comment", "", "   ", "FOO=bar", "  # indented comment"].join("\n")
  );
  assert.deepEqual(parsed, [{ key: "FOO", value: "bar" }]);
});

test("an `export` prefix is not part of the key", () => {
  assert.deepEqual(parseDotenv("export FOO=bar"), [{ key: "FOO", value: "bar" }]);
});

test("spaces around the `=` are not part of the key or value", () => {
  assert.deepEqual(parseDotenv("FOO = bar"), [{ key: "FOO", value: "bar" }]);
});

test("later definitions win, matching shell and dotenv", () => {
  assert.deepEqual(parseDotenv("FOO=first\nFOO=second"), [
    { key: "FOO", value: "second" },
  ]);
});

test("a re-defined key keeps its original position", () => {
  const parsed = parseDotenv("A=1\nB=2\nA=3");
  assert.deepEqual(parsed, [
    { key: "A", value: "3" },
    { key: "B", value: "2" },
  ]);
});

test("an unquoted value drops its trailing comment", () => {
  assert.deepEqual(parseDotenv("FOO=bar # trailing"), [
    { key: "FOO", value: "bar" },
  ]);
});

test("a `#` with no leading space is part of the value", () => {
  // Colors and URL fragments are the reason: `COLOR=#fff` must survive.
  assert.deepEqual(parseDotenv("COLOR=#fff"), [{ key: "COLOR", value: "#fff" }]);
});

test("quotes are stripped and let a value keep spaces and `#`", () => {
  assert.deepEqual(parseDotenv('FOO="bar baz # not a comment"'), [
    { key: "FOO", value: "bar baz # not a comment" },
  ]);
  assert.deepEqual(parseDotenv("FOO='bar baz'"), [
    { key: "FOO", value: "bar baz" },
  ]);
});

test("double quotes unescape \\n, \\r and \\\"", () => {
  assert.deepEqual(parseDotenv('KEY="line1\\nline2"'), [
    { key: "KEY", value: "line1\nline2" },
  ]);
  assert.deepEqual(parseDotenv('KEY="say \\"hi\\""'), [
    { key: "KEY", value: 'say "hi"' },
  ]);
});

test("single quotes keep escapes literal", () => {
  assert.deepEqual(parseDotenv("KEY='line1\\nline2'"), [
    { key: "KEY", value: "line1\\nline2" },
  ]);
});

test("mismatched quotes are not treated as a quote pair", () => {
  assert.deepEqual(parseDotenv("KEY=\"bar'"), [{ key: "KEY", value: "\"bar'" }]);
});

test("an empty value stays empty", () => {
  assert.deepEqual(parseDotenv("FOO="), [{ key: "FOO", value: "" }]);
  assert.deepEqual(parseDotenv('FOO=""'), [{ key: "FOO", value: "" }]);
});

test("a value containing `=` keeps everything after the first one", () => {
  assert.deepEqual(parseDotenv("DSN=postgres://u:p@h/db?x=1"), [
    { key: "DSN", value: "postgres://u:p@h/db?x=1" },
  ]);
});

test("lines that are not assignments are ignored", () => {
  assert.deepEqual(parseDotenv("just some prose\nFOO=bar"), [
    { key: "FOO", value: "bar" },
  ]);
});

test("a key may not start with a digit", () => {
  assert.deepEqual(parseDotenv("1FOO=bar"), []);
});

test("CRLF input parses the same as LF", () => {
  assert.deepEqual(parseDotenv("FOO=bar\r\nBAZ=qux"), [
    { key: "FOO", value: "bar" },
    { key: "BAZ", value: "qux" },
  ]);
});

test("a quoted value may span multiple lines", () => {
  assert.deepEqual(parseDotenv('KEY="-----BEGIN-----\nbody\n-----END-----"\nB=2'), [
    { key: "KEY", value: "-----BEGIN-----\nbody\n-----END-----" },
    { key: "B", value: "2" },
  ]);
});

test("a multi-line value is not reported as unparseable", () => {
  const { entries, invalidLines } = parseDotenvWithDiagnostics(
    'KEY="line1\nline2"\nB=2',
  );
  assert.deepEqual(entries, [
    { key: "KEY", value: "line1\nline2" },
    { key: "B", value: "2" },
  ]);
  assert.deepEqual(invalidLines, []);
});

test("parseDotenvWithDiagnostics reports skipped lines with 1-based numbers", () => {
  const { entries, invalidLines } = parseDotenvWithDiagnostics(
    "A=1\njust some prose\n1BAD=x\nB=2",
  );
  assert.deepEqual(entries, [
    { key: "A", value: "1" },
    { key: "B", value: "2" },
  ]);
  assert.deepEqual(invalidLines, [
    { line: 2, text: "just some prose" },
    { line: 3, text: "1BAD=x" },
  ]);
});

test("parseDotenvWithDiagnostics ignores blanks and comments", () => {
  const { entries, invalidLines } = parseDotenvWithDiagnostics(
    "# header\n\n  # indented\nA=1\n",
  );
  assert.deepEqual(entries, [{ key: "A", value: "1" }]);
  assert.deepEqual(invalidLines, []);
});

test("mergeEnv overwrites a matching key in place", () => {
  const merged = mergeEnv(
    [
      { key: "A", value: "1" },
      { key: "B", value: "2" },
    ],
    [{ key: "A", value: "changed" }]
  );
  assert.deepEqual(merged, [
    { key: "A", value: "changed" },
    { key: "B", value: "2" },
  ]);
});

test("mergeEnv appends keys it has not seen", () => {
  const merged = mergeEnv([{ key: "A", value: "1" }], [{ key: "B", value: "2" }]);
  assert.deepEqual(merged, [
    { key: "A", value: "1" },
    { key: "B", value: "2" },
  ]);
});

test("mergeEnv does not mutate its inputs", () => {
  const existing = [{ key: "A", value: "1" }];
  const incoming = [{ key: "A", value: "2" }];
  mergeEnv(existing, incoming);
  assert.deepEqual(existing, [{ key: "A", value: "1" }]);
  assert.deepEqual(incoming, [{ key: "A", value: "2" }]);
});

test("mergeEnv applies repeated incoming keys in order", () => {
  const merged = mergeEnv(
    [],
    [
      { key: "A", value: "first" },
      { key: "A", value: "second" },
    ]
  );
  assert.deepEqual(merged, [{ key: "A", value: "second" }]);
});
