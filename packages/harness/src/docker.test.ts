import { strict as assert } from "node:assert";
import { test } from "node:test";

import { run } from "./docker";

test("run captures stdout and exit code 0", async () => {
  const r = await run("sh", ["-c", "printf hello"]);
  assert.equal(r.stdout, "hello");
  assert.equal(r.stderr, "");
  assert.equal(r.exitCode, 0);
});

test("run captures stderr and non-zero exit code", async () => {
  const r = await run("sh", ["-c", "printf oops >&2; exit 3"]);
  assert.equal(r.stdout, "");
  assert.equal(r.stderr, "oops");
  assert.equal(r.exitCode, 3);
});

test("run pipes stdin to the child", async () => {
  const r = await run("cat", [], { stdin: "line1\nline2" });
  assert.equal(r.stdout, "line1\nline2");
  assert.equal(r.exitCode, 0);
});

test("run without stdin closes the child's stdin (cat exits)", async () => {
  const r = await run("cat", []);
  assert.equal(r.stdout, "");
  assert.equal(r.exitCode, 0);
});

test("a child that exits before reading stdin yields its code, not a crash", async () => {
  // Nobody drains the pipe and the payload is past its buffer, so the write
  // cannot finish and fails with EPIPE. With no error listener on stdin that
  // was an uncaught exception — the process died instead of this resolving.
  const r = await run("sh", ["-c", "exit 3"], { stdin: "x".repeat(1_000_000) });
  assert.equal(r.exitCode, 3);
});

test("run kills on timeout with exitCode 124", async () => {
  const r = await run("sh", ["-c", "sleep 10"], { timeoutMs: 200 });
  assert.equal(r.exitCode, 124);
});

test("run rejects when the binary does not exist", async () => {
  await assert.rejects(run("nexux-definitely-not-a-binary", []));
});

test("args pass verbatim — no shell interpolation", async () => {
  const r = await run("printf", ["%s", "$(echo injected); `whoami`"]);
  assert.equal(r.stdout, "$(echo injected); `whoami`");
  assert.equal(r.exitCode, 0);
});
