import { strict as assert } from "node:assert";
import { test } from "node:test";

import { sameCommit } from "./build-sha";

const FULL = "3839a18e762a4231937af6dc3b38a44bebe99397";

test("a full sha matches the abbreviation it abbreviates", () => {
  // The image bakes a full 40-char sha; a `git describe` carries seven, and a
  // tag ref comes back full. All three name the same commit and the check has
  // to say so.
  assert.ok(sameCommit(FULL, "3839a18"));
  assert.ok(sameCommit("3839a18", FULL));
  assert.ok(sameCommit(FULL, FULL));
});

test("case does not decide whether two commits are the same", () => {
  assert.ok(sameCommit(FULL.toUpperCase(), FULL));
  assert.ok(sameCommit(" 3839A18 ", FULL));
});

test("different commits do not match", () => {
  assert.equal(sameCommit(FULL, "b6631d6ca1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6"), false);
  assert.equal(sameCommit("3839a18", "3839a19"), false);
});

test("a missing sha never matches", () => {
  // The dev path and an image built without the arg both answer null, and
  // "unknown" must not be read as "same commit" — that would silence the
  // update check for every install that cannot identify itself.
  assert.equal(sameCommit(null, FULL), false);
  assert.equal(sameCommit(FULL, null), false);
  assert.equal(sameCommit(null, null), false);
  assert.equal(sameCommit("", FULL), false);
  assert.equal(sameCommit(undefined, FULL), false);
});

test("a prefix too short to trust does not match", () => {
  // Below git's seven-character default, a prefix collides across a real
  // repository — matching on it would claim two unrelated commits are one.
  assert.equal(sameCommit("3839a1", FULL), false);
  assert.equal(sameCommit("38", FULL), false);
});
