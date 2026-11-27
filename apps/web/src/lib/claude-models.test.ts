import assert from "node:assert/strict";
import { test } from "node:test";

import { effortLabel, modelShortLabel, searchModels } from "./claude-models";

test("the chip names the model: known, alias, custom, or the default", () => {
  assert.equal(modelShortLabel("claude-opus-5-5"), "Opus 5.5");
  assert.equal(modelShortLabel("sonnet"), "Sonnet");
  assert.equal(modelShortLabel("my-model"), "my-model");
  assert.equal(modelShortLabel(null), "Default");
  assert.equal(effortLabel("xhigh"), "Extra High");
  assert.equal(effortLabel(null), null);
});

test("searching filters models, and an unknown name can be used as typed", () => {
  assert.deepEqual(searchModels("son").models.map((m) => m.id), ["claude-sonnet-5-5"]);
  assert.equal(searchModels("").models.length, 4);
  assert.equal(searchModels("claude-opus-4-1").custom, "claude-opus-4-1");
  assert.equal(searchModels("x; rm -rf").custom, null);
});
