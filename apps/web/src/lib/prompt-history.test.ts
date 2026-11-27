import assert from "node:assert/strict";
import { test } from "node:test";

import { caretAllowsHistory, promptHistory, stepHistory } from "./prompt-history";

test("history drops blanks and back-to-back repeats", () => {
  assert.deepEqual(promptHistory(["a", " ", "b", "b ", "a"]), ["a", "b", "a"]);
});

test("↑ walks back from the draft, ↓ returns to it", () => {
  const h = ["one", "two", "three"];
  assert.deepEqual(stepHistory(h, null, -1), { index: 2 });
  assert.deepEqual(stepHistory(h, 2, -1), { index: 1 });
  assert.equal(stepHistory(h, 0, -1), null);
  assert.deepEqual(stepHistory(h, 1, 1), { index: 2 });
  assert.deepEqual(stepHistory(h, 2, 1), { index: null });
  assert.equal(stepHistory(h, null, 1), null);
  assert.equal(stepHistory([], null, -1), null);
});

test("inside a multi-line message the arrows move the caret instead", () => {
  assert.equal(caretAllowsHistory("a\nb", 0, -1), true);
  assert.equal(caretAllowsHistory("a\nb", 3, -1), false);
  assert.equal(caretAllowsHistory("a\nb", 3, 1), true);
  assert.equal(caretAllowsHistory("a\nb", 0, 1), false);
});
