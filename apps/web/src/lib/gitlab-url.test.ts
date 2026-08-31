import assert from "node:assert/strict";
import { test } from "node:test";

import { describeRef, parseGitLabUrl } from "./gitlab-url";

const HOST = "https://git.example.com";

/** The URL that motivated all of this — a group board scoped to a milestone. */
const BOARD_URL = `${HOST}/groups/civo/-/boards/151?milestone_title=New+Dashboard:+Feedback+Round+(Aug+2026)`;

test("a group board keeps its id and its milestone filter", () => {
  const parsed = parseGitLabUrl(BOARD_URL);
  assert.deepEqual(parsed, {
    origin: HOST,
    ref: {
      kind: "board",
      ownerPath: "civo",
      owner: "group",
      boardId: 151,
      milestoneTitle: "New Dashboard: Feedback Round (Aug 2026)",
    },
  });
});

test("a board under a nested group keeps the whole path", () => {
  const { ref } = parseGitLabUrl(`${HOST}/groups/civo/dashboard/-/boards/9`)!;
  assert.deepEqual(ref, {
    kind: "board",
    ownerPath: "civo/dashboard",
    owner: "group",
    boardId: 9,
    milestoneTitle: null,
  });
});

test("a project board is told apart from a group one", () => {
  const { ref } = parseGitLabUrl(
    `${HOST}/civo/dashboard/volumes-micro-frontend/-/boards/4`,
  )!;
  assert.deepEqual(ref, {
    kind: "board",
    ownerPath: "civo/dashboard/volumes-micro-frontend",
    owner: "project",
    boardId: 4,
    milestoneTitle: null,
  });
});

test("an epic URL resolves to its group and iid", () => {
  const { ref } = parseGitLabUrl(`${HOST}/groups/operators/-/epics/6`)!;
  assert.deepEqual(ref, { kind: "epic", groupPath: "operators", epicIid: 6 });
});

test("an issue list filtered by milestone is the same slice as a board", () => {
  const { ref } = parseGitLabUrl(
    `${HOST}/groups/civo/-/issues?milestone_title=Sprint+12&state=opened`,
  )!;
  assert.deepEqual(ref, {
    kind: "milestone",
    ownerPath: "civo",
    owner: "group",
    milestoneTitle: "Sprint 12",
  });
});

test("a group page with no resource is the group itself", () => {
  assert.deepEqual(parseGitLabUrl(`${HOST}/groups/civo/dashboard`)!.ref, {
    kind: "group",
    groupPath: "civo/dashboard",
  });
  // A trailing slash and a deeper resource both still name the group.
  assert.deepEqual(parseGitLabUrl(`${HOST}/groups/operators/-/issues`)!.ref, {
    kind: "group",
    groupPath: "operators",
  });
});

test("a project resource names the project", () => {
  assert.deepEqual(
    parseGitLabUrl(`${HOST}/civo/platform/bridge/-/issues/215`)!.ref,
    { kind: "project", projectPath: "civo/platform/bridge" },
  );
});

// `civo/dashboard` really is a subgroup on the instance this was built against,
// so a bare path cannot be called a project without asking the server.
test("a bare path is reported as ambiguous rather than guessed", () => {
  assert.deepEqual(parseGitLabUrl(`${HOST}/civo/dashboard`)!.ref, {
    kind: "ambiguous",
    path: "civo/dashboard",
  });
  assert.deepEqual(parseGitLabUrl(`${HOST}/operators`)!.ref, {
    kind: "ambiguous",
    path: "operators",
  });
});

test("the origin comes back so it can be matched against a server", () => {
  assert.equal(parseGitLabUrl(BOARD_URL)!.origin, HOST);
  assert.equal(
    parseGitLabUrl("gitlab.com/groups/x/-/boards/1")!.origin,
    "https://gitlab.com",
  );
  assert.equal(
    parseGitLabUrl("http://gitlab.internal:8443/groups/x/-/boards/1")!.origin,
    "http://gitlab.internal:8443",
  );
});

test("junk and empty input parse to nothing", () => {
  for (const bad of ["", "   ", "not a url", "https://", `${HOST}/`]) {
    assert.equal(parseGitLabUrl(bad), null, `expected null for ${JSON.stringify(bad)}`);
  }
});

test("a board with no id in the path is not mistaken for board zero", () => {
  // GitLab's default board has no id; treating it as one would 404 later.
  assert.deepEqual(parseGitLabUrl(`${HOST}/groups/civo/-/boards`)!.ref, {
    kind: "group",
    groupPath: "civo",
  });
});

test("describeRef says what was recognised, for the dialog to echo back", () => {
  assert.equal(
    describeRef(parseGitLabUrl(BOARD_URL)!.ref),
    'board #151 in civo, milestone "New Dashboard: Feedback Round (Aug 2026)"',
  );
  assert.equal(
    describeRef(parseGitLabUrl(`${HOST}/groups/operators/-/epics/6`)!.ref),
    "epic &6 in operators",
  );
});
