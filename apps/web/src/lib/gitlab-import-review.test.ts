import assert from "node:assert/strict";
import { test } from "node:test";

import {
  importPrompt,
  selectionGroupsOf,
  shouldShowProjectPath,
  type ReviewRow,
} from "./gitlab-import-review";

const base = {
  accountId: "acc",
  hasResolvedUrl: false,
  scope: "project" as const,
  hasProject: false,
  hasGroup: false,
  hasEpic: false,
};

const row = (over: Partial<ReviewRow> = {}): ReviewRow => ({
  included: true,
  state: "opened",
  projectPath: "acme/web",
  boardStatus: null,
  ...over,
});

// The regression this file exists for: a pasted board URL rendered
// "Pick a project to load its issues." and its whole review tree — every
// checkbox with it — never appeared, because the default scope shadowed it.
test("a resolved URL suppresses every picker prompt", () => {
  for (const scope of ["project", "group", "epic"] as const) {
    assert.equal(
      importPrompt({ ...base, scope, hasResolvedUrl: true }),
      null,
      `${scope} scope should defer to a resolved URL`,
    );
  }
});

test("without a URL the pickers still ask for what they need", () => {
  assert.match(importPrompt({ ...base })!, /Pick a project/);
  assert.match(importPrompt({ ...base, scope: "group" })!, /Pick a group/);
  assert.match(
    importPrompt({ ...base, scope: "epic" })!,
    /Pick the group whose epics/,
  );
  assert.match(
    importPrompt({ ...base, scope: "epic", hasGroup: true })!,
    /Pick an epic/,
  );
});

test("a satisfied picker shows the tree, not a prompt", () => {
  assert.equal(importPrompt({ ...base, hasProject: true }), null);
  assert.equal(importPrompt({ ...base, scope: "group", hasGroup: true }), null);
  assert.equal(
    importPrompt({ ...base, scope: "epic", hasGroup: true, hasEpic: true }),
    null,
  );
});

test("no server selected means no prompt at all — the empty state covers it", () => {
  assert.equal(importPrompt({ ...base, accountId: "" }), null);
});

// --- bulk selection --------------------------------------------------------

test("board rows group by column, in the board's own order", () => {
  const review = [
    row({ boardStatus: "Done", included: false }),
    row({ boardStatus: "To do" }),
    row({ boardStatus: "Ready for Review" }),
    row({ boardStatus: "To do", included: false }),
  ];
  const groups = selectionGroupsOf(review, [
    "To do",
    "In progress",
    "Ready for Review",
    "Done",
  ]);
  assert.deepEqual(
    groups.map((g) => [g.label, g.chosen, g.indices.length]),
    [
      ["To do", 1, 2],
      ["Ready for Review", 1, 1],
      ["Done", 0, 1],
    ],
  );
  // Indices are what the toggle flips, so they must point at the right rows.
  assert.deepEqual(groups[0].indices, [1, 3]);
});

test("an issue with no column sorts after the ones the board named", () => {
  const groups = selectionGroupsOf(
    [row({ boardStatus: "Done" }), row({ boardStatus: null })],
    ["To do", "Done"],
  );
  assert.deepEqual(groups.map((g) => g.label), ["Done", "No column"]);
});

test("without a board the grouping falls back to open and closed", () => {
  const groups = selectionGroupsOf([
    row({ state: "opened" }),
    row({ state: "closed", included: false }),
    row({ state: "closed", included: false }),
  ]);
  assert.deepEqual(
    groups.map((g) => [g.label, g.chosen, g.indices.length]),
    [
      ["Closed", 0, 2],
      ["Open", 1, 1],
    ],
  );
});

test("an empty review has nothing to group", () => {
  assert.deepEqual(selectionGroupsOf([]), []);
});

test("the project name shows only once the rows span repositories", () => {
  assert.equal(shouldShowProjectPath([row(), row()]), false);
  assert.equal(
    shouldShowProjectPath([row(), row({ projectPath: "acme/infra/tf" })]),
    true,
  );
  assert.equal(shouldShowProjectPath([]), false);
});
