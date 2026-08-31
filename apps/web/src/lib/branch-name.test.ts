import assert from "node:assert/strict";
import { test } from "node:test";

import {
  branchName,
  branchSlug,
  conventionalTitle,
  conventionalType,
} from "./branch-name";

// Branches used to be `nexux/<the entire title>-<id>` — the tool's name plus
// 110 characters of feature title. These pin the replacement against the
// titles this install actually produced.

// --- conventionalType --------------------------------------------------------

test("an explicit prefix outranks any guess", () => {
  // Already classified by whoever wrote it; guessing again can only disagree.
  assert.equal(conventionalType("fix: add a new dashboard"), "fix");
  assert.equal(conventionalType("chore(deps): add feature flags"), "chore");
});

test("the tracker's Bug: prefix is a fix", () => {
  assert.equal(
    conventionalType(
      "Bug: Accessibility - some elements lack semantic roles/labels, forcing e2e tests to query by visible text",
    ),
    "fix",
  );
});

test("an unknown prefix falls through to the keywords", () => {
  // "Spike:" is not a conventional type, so the rest of the title decides.
  assert.equal(conventionalType("Spike: add a mock server"), "feat");
});

test("adding something is a feat", () => {
  assert.equal(
    conventionalType("Add stateful acme-api mock server and UI backend switch"),
    "feat",
  );
});

test("a fix beats a test mentioned in the same title", () => {
  // The order of the rules is the precedence: a bug that breaks tests is a
  // fix with a test, not a test.
  assert.equal(conventionalType("Fix failing e2e tests on login"), "fix");
});

test("spanish titles classify too", () => {
  // Features here are written in both languages; an English-only classifier
  // would file half of them as feat.
  assert.equal(conventionalType("Corregir el error del selector de región"), "fix");
  assert.equal(conventionalType("Actualizar la documentación del readme"), "docs");
  assert.equal(conventionalType("Optimizar el rendimiento del dashboard"), "perf");
});

test("docs, test, refactor, perf and chore each land", () => {
  assert.equal(conventionalType("Update the README with setup steps"), "docs");
  assert.equal(conventionalType("Add coverage for the auth service"), "test");
  assert.equal(conventionalType("Refactor the sandbox manager"), "refactor");
  assert.equal(conventionalType("Fix the memory leak"), "fix");
  assert.equal(conventionalType("Bump dependencies to latest"), "chore");
});

test("anything unrecognised is a feat, not a fix", () => {
  // A wrong feat is a smaller lie than a wrong fix, which tells a reviewer
  // something broke when nothing did.
  assert.equal(conventionalType("Zippy dashboard for the ops team"), "feat");
  assert.equal(conventionalType(""), "feat");
});

// --- branchSlug --------------------------------------------------------------

test("a long title is cut at a word boundary", () => {
  const slug = branchSlug(
    "Bug: Accessibility - some elements lack semantic roles/labels, forcing e2e tests to query by visible text",
  );
  assert.ok(slug.length <= 48, `got ${slug.length}: ${slug}`);
  assert.ok(!slug.endsWith("-"), "no trailing separator");
  assert.ok(!slug.startsWith("bug-"), "the prefix became the type");
});

test("a short title survives whole", () => {
  assert.equal(branchSlug("Add login"), "add-login");
});

test("punctuation and accents collapse to single dashes", () => {
  assert.equal(branchSlug("Región: selector — v2!"), "regi-n-selector-v2");
});

test("a title with nothing usable still yields a slug", () => {
  // Git will not take an empty ref, and "" is what a punctuation-only title
  // reduces to.
  assert.equal(branchSlug("!!! ???"), "task");
  assert.equal(branchSlug(""), "task");
});

test("one very long first word is cut rather than dropped", () => {
  const slug = branchSlug("supercalifragilisticexpialidociousandthensome extra");
  assert.ok(slug.length <= 48);
  assert.ok(slug.length > 0);
});

// --- branchName --------------------------------------------------------------

test("the branch is type/slug-suffix and no longer names the tool", () => {
  const branch = branchName("Add login page", "ab12x");
  assert.equal(branch, "feat/add-login-page-ab12x");
  assert.ok(!branch.startsWith("nexux/"));
});

test("the suffix is kept even on a short slug", () => {
  // Re-dispatching a feature is routine, and it is the only thing keeping two
  // runs of it apart.
  assert.match(branchName("Add login", "zz999"), /-zz999$/);
});

test("a real title produces a branch a reviewer can read", () => {
  const branch = branchName(
    "Bug: Accessibility - some elements lack semantic roles/labels, forcing e2e tests to query by visible text",
    "6xj4m",
  );
  assert.ok(branch.startsWith("fix/"));
  assert.ok(branch.length <= 60, `got ${branch.length}: ${branch}`);
});

// --- conventionalTitle -------------------------------------------------------

test("the PR title gains its type", () => {
  assert.equal(conventionalTitle("Add login page"), "feat: add login page");
});

test("a title that already has a valid prefix is left alone", () => {
  // Re-prefixing would produce "feat: fix: …".
  assert.equal(conventionalTitle("fix: broken redirect"), "fix: broken redirect");
  assert.equal(
    conventionalTitle("chore(deps): bump prisma"),
    "chore(deps): bump prisma",
  );
});

test("the tracker's Bug: prefix is replaced, not stacked", () => {
  assert.equal(
    conventionalTitle("Bug: broken redirect on login"),
    "fix: broken redirect on login",
  );
});

test("an empty subject falls back to the whole title", () => {
  // Degenerate input: "Bug:" still classifies as a fix from its prefix, and
  // stripping that prefix leaves nothing, so the original stands in rather
  // than producing a title with no subject at all.
  assert.equal(conventionalTitle("Bug:"), "fix: bug:");
});
