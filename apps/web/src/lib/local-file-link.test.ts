import assert from "node:assert/strict";
import { test } from "node:test";

import { parseLocalFileLink } from "./local-file-link";

test("local paths, with a line and column, are recognised", () => {
  assert.deepEqual(parseLocalFileLink("/Users/me/p/a.ts"), { path: "/Users/me/p/a.ts" });
  assert.deepEqual(parseLocalFileLink("/Users/me/p/a.ts:42"), { path: "/Users/me/p/a.ts", line: 42 });
  assert.deepEqual(parseLocalFileLink("~/p/a.ts:4:2"), { path: "~/p/a.ts", line: 4, column: 2 });
  assert.deepEqual(parseLocalFileLink("file:///Users/me/My%20Folder/x.pine"), { path: "/Users/me/My Folder/x.pine" });
  assert.deepEqual(parseLocalFileLink("/Users/me/a.ts#L10"), { path: "/Users/me/a.ts", line: 10 });
});

test("web links, app routes and bot files are not local files", () => {
  for (const href of ["https://x.dev/a", "/api/bots/1/files/a.png", "/bots", "#mention", "", null]) {
    assert.equal(parseLocalFileLink(href), null, String(href));
  }
});
