import { strict as assert } from "node:assert";
import { test } from "node:test";

import { cosineSimilarity, describeSimilarity } from "./embedding-test";

test("cosine similarity of known vectors", () => {
  assert.equal(cosineSimilarity([1, 0], [1, 0]), 1);
  assert.equal(cosineSimilarity([1, 0], [0, 1]), 0);
  assert.equal(cosineSimilarity([1, 0], [-1, 0]), -1);
  assert.ok(Math.abs(cosineSimilarity([1, 2, 3], [2, 4, 6]) - 1) < 1e-12);
});

test("degenerate vectors score 0 instead of NaN", () => {
  assert.equal(cosineSimilarity([], []), 0);
  assert.equal(cosineSimilarity([0, 0], [1, 1]), 0);
  assert.equal(cosineSimilarity([1], [1, 2]), 0);
});

test("scores read as words", () => {
  assert.match(describeSimilarity(0.9), /same idea/);
  assert.equal(describeSimilarity(0.3), "unrelated");
});
