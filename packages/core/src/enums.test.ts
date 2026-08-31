import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  CLONE_STATUSES,
  CONVERSATION_STATUSES,
  FEATURE_PRIORITIES,
  FEATURE_PR_MODES,
  FEATURE_STATUSES,
  PLAN_STATUSES,
  createPrToPrMode,
  prModeToCreatePr,
  type FeaturePrMode,
} from "./enums";

// The DB stores these as plain strings (see schema.prisma comments), so the
// exact values are a compatibility contract, not an implementation detail.

test("feature statuses match the kanban lifecycle", () => {
  assert.deepEqual(FEATURE_STATUSES, [
    "backlog",
    "todo",
    "queued",
    "in_progress",
    "in_review",
    "done",
  ]);
});

test("feature priorities are ordered low to urgent", () => {
  assert.deepEqual(FEATURE_PRIORITIES, ["low", "medium", "high", "urgent"]);
});

test("conversation statuses cover the run lifecycle", () => {
  assert.deepEqual(CONVERSATION_STATUSES, [
    "idle",
    "running",
    "paused",
    "completed",
    "error",
  ]);
});

test("clone statuses match Repository.cloneStatus defaults", () => {
  assert.deepEqual(CLONE_STATUSES, ["pending", "cloning", "ready", "error"]);
});

test("plan statuses cover the review flow", () => {
  assert.deepEqual(PLAN_STATUSES, [
    "draft",
    "pending_review",
    "approved",
    "rejected",
  ]);
});

test("no duplicate values within any status list", () => {
  for (const list of [
    FEATURE_STATUSES,
    FEATURE_PRIORITIES,
    CONVERSATION_STATUSES,
    CLONE_STATUSES,
    PLAN_STATUSES,
    FEATURE_PR_MODES,
  ]) {
    assert.equal(new Set(list).size, list.length);
  }
});

// Feature.createPr is nullable so "inherit" survives a round-trip as a state
// of its own — collapsing it to false would silently stop features from
// following the project's sandbox policy.

test("inherit maps to null, not to a boolean", () => {
  assert.equal(prModeToCreatePr("inherit"), null);
});

test("always and never pin the feature to a real boolean", () => {
  assert.equal(prModeToCreatePr("always"), true);
  assert.equal(prModeToCreatePr("never"), false);
});

test("a null or undefined column reads back as inherit", () => {
  assert.equal(createPrToPrMode(null), "inherit");
  assert.equal(createPrToPrMode(undefined), "inherit");
});

test("stored booleans read back as the pinned modes", () => {
  assert.equal(createPrToPrMode(true), "always");
  assert.equal(createPrToPrMode(false), "never");
});

test("every mode round-trips through the stored column", () => {
  for (const mode of FEATURE_PR_MODES) {
    assert.equal(createPrToPrMode(prModeToCreatePr(mode)), mode);
  }
});

test("the mode list covers exactly the three states the UI offers", () => {
  const modes: FeaturePrMode[] = ["inherit", "always", "never"];
  assert.deepEqual(FEATURE_PR_MODES, modes);
});
