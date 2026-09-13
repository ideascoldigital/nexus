import assert from "node:assert/strict";
import { test } from "node:test";

import "./services.test-setup";
import { SANDBOX_LOG_SOURCES, taskScreenshotUrl } from "./tasks";

// --- taskScreenshotUrl -------------------------------------------------------
// The screenshot name comes off disk in the sandbox, so it is not a value this
// side chose. It lands in a URL path segment, which is the one place an
// unescaped `/` or `..` changes which route is called.

test("a plain name builds the screenshots route", () => {
  assert.equal(
    taskScreenshotUrl("p1", "t1", "shot.png"),
    "/api/projects/p1/tasks/t1/screenshots/shot.png",
  );
});

test("a traversal attempt cannot climb out of the segment", () => {
  // Unencoded, `../../etc/passwd` would resolve against the route and ask the
  // server for something well above the screenshots directory. Encoded, the
  // slashes stay data and the whole thing remains one segment.
  const url = taskScreenshotUrl("p1", "t1", "../../etc/passwd");
  assert.equal(
    url,
    "/api/projects/p1/tasks/t1/screenshots/..%2F..%2Fetc%2Fpasswd",
  );
  assert.ok(!url.includes("../"));
});

test("a slash inside a name stays inside the segment", () => {
  assert.equal(
    taskScreenshotUrl("p1", "t1", "a/b.png"),
    "/api/projects/p1/tasks/t1/screenshots/a%2Fb.png",
  );
});

test("a query or fragment character cannot start one", () => {
  // An unescaped `?` would turn the rest of the name into a query string and
  // the route would receive a truncated filename.
  const url = taskScreenshotUrl("p1", "t1", "a?x=1&y=2#z");
  assert.equal(
    url,
    "/api/projects/p1/tasks/t1/screenshots/a%3Fx%3D1%26y%3D2%23z",
  );
  assert.ok(!url.includes("?"));
  assert.ok(!url.includes("#"));
});

test("a space is encoded rather than breaking the URL", () => {
  assert.equal(
    taskScreenshotUrl("p1", "t1", "a b.png"),
    "/api/projects/p1/tasks/t1/screenshots/a%20b.png",
  );
});

test("a non-ascii name survives as utf-8", () => {
  assert.equal(
    taskScreenshotUrl("p1", "t1", "é.png"),
    "/api/projects/p1/tasks/t1/screenshots/%C3%A9.png",
  );
});

test("a literal percent is escaped, so the name round-trips", () => {
  // `100%.png` left alone is an invalid escape and decoding it throws.
  const url = taskScreenshotUrl("p1", "t1", "100%.png");
  assert.equal(url, "/api/projects/p1/tasks/t1/screenshots/100%25.png");
  assert.equal(decodeURIComponent(url.split("/").pop()!), "100%.png");
});

// --- SANDBOX_LOG_SOURCES -----------------------------------------------------
// These ids select a server-side path. The list is the whole allowlist, so a
// duplicate or a stray id is what would let an unintended path be chosen.

test("every log source id is unique", () => {
  const ids = SANDBOX_LOG_SOURCES.map((s) => s.id);
  assert.equal(new Set(ids).size, ids.length);
});

test("the log sources are the five the server serves", () => {
  assert.deepEqual(
    SANDBOX_LOG_SOURCES.map((s) => s.id),
    ["app", "tunnel", "bootstrap", "stack", "dockerd"],
  );
});

test("every log source has a label to show", () => {
  // An id with no label renders as an empty tab.
  for (const source of SANDBOX_LOG_SOURCES) {
    assert.ok(source.label.length > 0, `${source.id} has no label`);
  }
});

test("no log source id could be read as a path", () => {
  for (const source of SANDBOX_LOG_SOURCES) {
    assert.ok(!source.id.includes("/"), `${source.id} contains a slash`);
    assert.ok(!source.id.includes("."), `${source.id} contains a dot`);
  }
});
