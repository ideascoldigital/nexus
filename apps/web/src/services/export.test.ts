import assert from "node:assert/strict";
import { test } from "node:test";

import { MIN_PASSPHRASE, buildQuery, fileIsEncrypted } from "./export";

test("an all-scope export needs no query string", () => {
  assert.equal(
    buildQuery({ scope: { kind: "all" }, includeConversations: false }),
    "/api/export",
  );
});

test("scope=project repeats projectId rather than joining ids", () => {
  // The route reads them with getAll(); a comma-joined value would arrive as
  // one bogus id.
  const url = buildQuery({
    scope: { kind: "project", projectIds: ["a", "b"] },
    includeConversations: false,
  });
  assert.equal(url, "/api/export?scope=project&projectId=a&projectId=b");
});

test("optional flags only appear when set", () => {
  const url = buildQuery({
    scope: { kind: "all" },
    includeConversations: true,
    pathRoot: "/Users/j/ws",
  });
  const params = new URL(url, "http://test").searchParams;
  assert.equal(params.get("includeConversations"), "true");
  assert.equal(params.get("pathRoot"), "/Users/j/ws");
  assert.equal(params.get("scope"), null);
});

test("template rides the GET url as a flag", () => {
  const url = buildQuery({
    scope: { kind: "project", projectIds: ["a"] },
    includeConversations: false,
    template: true,
  });
  const params = new URL(url, "http://test").searchParams;
  assert.equal(params.get("template"), "true");
  assert.equal(
    buildQuery({ scope: { kind: "all" }, includeConversations: false }),
    "/api/export",
    "absent unless set",
  );
});

test("no passphrase can reach the GET url", () => {
  // The secretless path is the only one that builds a query; secrets go by
  // POST so the passphrase stays out of logs and history.
  const url = buildQuery({
    scope: { kind: "all" },
    includeConversations: false,
    pathRoot: "/x",
  });
  assert.ok(!url.includes("passphrase"));
  assert.ok(!url.includes("includeSecrets"));
});

test("MIN_PASSPHRASE mirrors the server's floor", () => {
  assert.equal(MIN_PASSPHRASE, 12);
});

test("fileIsEncrypted spots a sealed envelope so the UI can ask for a passphrase", () => {
  assert.equal(fileIsEncrypted({ encrypted: true, payload: "..." }), true);
  assert.equal(fileIsEncrypted({ meta: {}, projects: [] }), false);
  assert.equal(fileIsEncrypted(null), false);
  assert.equal(fileIsEncrypted("a string"), false);
});
