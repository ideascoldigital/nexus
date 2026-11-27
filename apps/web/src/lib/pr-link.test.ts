import assert from "node:assert/strict";
import { test } from "node:test";

import { parsePrLink } from "./pr-link";

test("a GitHub pull request reads as owner/repo #n", () => {
  const pr = parsePrLink("https://github.com/ideascoldigital/nexus/pull/16/files");
  assert.equal(pr?.host, "github");
  assert.equal(pr?.number, "16");
  assert.equal(pr?.label, "ideascoldigital/nexus #16");
});

test("a GitLab merge request (nested groups) reads as repo !n", () => {
  const pr = parsePrLink("git.civo.com/civo/colony/colony-api/-/merge_requests/321");
  assert.equal(pr?.host, "gitlab");
  assert.equal(pr?.repo, "civo/colony/colony-api");
  assert.equal(pr?.label, "colony-api !321");
});

test("any other link is kept, anything else refused", () => {
  assert.equal(parsePrLink("https://example.com/review/9")?.host, "other");
  assert.equal(parsePrLink("not a link"), null);
  assert.equal(parsePrLink("javascript:alert(1)"), null);
});
