import assert from "node:assert/strict";
import { test } from "node:test";

import {
  commonRoot,
  isUnder,
  normalise,
  relativise,
  resolvePortable,
} from "./paths";

test("normalise collapses and forward-slashes", () => {
  assert.equal(normalise("/a/b/../c/"), "/a/c");
  assert.equal(normalise("C:\\Users\\dev\\ws"), "C:/Users/dev/ws");
  assert.equal(normalise("/"), "/");
});

test("commonRoot is segment-wise, not character-wise", () => {
  // The trap: /a/foo and /a/foobar share the string "/a/foo" but not a dir.
  assert.equal(commonRoot(["/a/foo", "/a/foobar"]), "/a");
  assert.equal(
    commonRoot(["/Users/j/ws/one", "/Users/j/ws/two"]),
    "/Users/j/ws",
  );
});

test("commonRoot of a single path is its parent, not itself", () => {
  // Otherwise a one-project export sets pathRoot to that project's own
  // workspacePath and rel becomes "", losing the project's directory name.
  assert.equal(commonRoot(["/Users/j/ws/metaphor"]), "/Users/j/ws");
});

test("commonRoot never returns a path that is itself being exported", () => {
  // The normal layout: repos live inside the project's workspace, so the
  // workspace IS the longest common prefix. Returning it would give that path
  // rel === "" — erasing the project's own directory name, which then resolves
  // to the bare destination root on import.
  assert.equal(
    commonRoot(["/Users/j/ws/metaphor", "/Users/j/ws/metaphor/web"]),
    "/Users/j/ws",
  );
  assert.deepEqual(
    relativise("/Users/j/ws/metaphor", commonRoot(["/Users/j/ws/metaphor", "/Users/j/ws/metaphor/web"])),
    { root: "pathRoot", rel: "metaphor" },
  );
});

test("commonRoot handles no shared prefix and empty input", () => {
  assert.equal(commonRoot(["/opt/a", "/var/b"]), "/");
  assert.equal(commonRoot([]), "");
  assert.equal(commonRoot(["", ""]), "");
});

test("isUnder does not match a sibling with a shared prefix", () => {
  assert.equal(isUnder("/a/foo", "/a/foo/bar"), true);
  assert.equal(isUnder("/a/foo", "/a/foo"), true);
  assert.equal(isUnder("/a/foo", "/a/foobar"), false);
  assert.equal(isUnder("", "/a"), false);
});

test("relativise rebases under the root and flags what is outside", () => {
  const root = "/Users/j/ws";
  assert.deepEqual(relativise("/Users/j/ws/metaphor/web", root), {
    root: "pathRoot",
    rel: "metaphor/web",
  });
  assert.deepEqual(relativise("/opt/elsewhere", root), {
    root: "absolute",
    abs: "/opt/elsewhere",
  });
  assert.equal(relativise(null, root), null);
});

test("round trip rebases a mac path onto a linux root", () => {
  const portable = relativise("/Users/dev/workspace/metaphor", "/Users/dev/workspace");
  assert.equal(resolvePortable(portable, "/opt/workspace"), "/opt/workspace/metaphor");
});

test("absolute-marked paths pass through resolve untouched", () => {
  const portable = relativise("/opt/elsewhere", "/Users/j/ws");
  assert.equal(resolvePortable(portable, "/opt/workspace"), "/opt/elsewhere");
});

test("a pathRoot-relative entry is unresolvable without a destination root", () => {
  // The import dry run reports this rather than inventing a location.
  const portable = relativise("/Users/j/ws/x", "/Users/j/ws");
  assert.equal(resolvePortable(portable, ""), null);
});

test("rel of the root itself resolves back to the root", () => {
  const portable = relativise("/Users/j/ws", "/Users/j/ws");
  assert.deepEqual(portable, { root: "pathRoot", rel: "" });
  assert.equal(resolvePortable(portable, "/opt/ws"), "/opt/ws");
});
