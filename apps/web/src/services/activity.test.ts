import assert from "node:assert/strict";
import { test } from "node:test";

import {
  activityCounts,
  activityHref,
  newlyFinished,
  notifications,
  unseenSince,
  type ActivityEntry,
} from "./activity";

// The switcher's two decisions that are not rendering: where an entry lands,
// and what counts as new since you last looked.

const entry = (over: Partial<ActivityEntry> = {}): ActivityEntry => ({
  kind: "task",
  id: "t1",
  taskKind: "task",
  status: "completed",
  phase: null,
  title: "Add login",
  projectId: "p1",
  projectName: "Main",
  sandboxId: "s1",
  sandboxName: "box",
  needsInput: false,
  updatedAt: "2026-08-12T10:00:00.000Z",
  finishedAt: "2026-08-12T10:00:00.000Z",
  ...over,
});

// --- activityHref ------------------------------------------------------------
// Dev prompts live beside their console in the Sandboxes tab; feature runs live
// on the board. Two places deciding this differently is how a "jump to it" link
// stops landing where the thing is.

test("a dev prompt opens its console, not just the tab", () => {
  // Landing on the tab is not arriving at the thing: a project with six
  // sandboxes would still leave you scanning for the one that was waiting.
  assert.equal(
    activityHref(entry({ taskKind: "dev", sandboxId: "s7" })),
    "/projects/p1?tab=sandboxes&sandbox=s7&dev=1",
  );
});

test("a feature run opens the board, pointing at its sandbox", () => {
  assert.equal(
    activityHref(entry({ taskKind: "task", sandboxId: "s7" })),
    "/projects/p1?tab=features&sandbox=s7",
  );
});

test("a feature run does not open a console it has none of", () => {
  assert.ok(!activityHref(entry({ taskKind: "task" })).includes("dev=1"));
});

test("a sandbox names itself, since it has no task to point through", () => {
  assert.equal(
    activityHref({
      kind: "sandbox",
      id: "s9",
      name: "box",
      provider: "civo",
      projectId: "p2",
      projectName: "Other",
    }),
    "/projects/p2?tab=sandboxes&sandbox=s9",
  );
});

test("every entry names a sandbox to reach", () => {
  // The row to scroll to is the whole point of the link; an href without it
  // is the old behaviour wearing the new shape.
  for (const href of [
    activityHref(entry({ taskKind: "dev", sandboxId: "a" })),
    activityHref(entry({ taskKind: "task", sandboxId: "b" })),
    activityHref({
      kind: "sandbox",
      id: "c",
      name: "n",
      provider: "local",
      projectId: "p",
      projectName: "P",
    }),
  ]) {
    assert.match(href, /[?&]sandbox=[a-z]/);
  }
});

// --- unseenSince -------------------------------------------------------------

test("with no mark yet nothing counts as unseen", () => {
  // A first run should not open onto a wall of history it never missed.
  assert.deepEqual(unseenSince([entry(), entry({ id: "t2" })], null), []);
});

test("only runs that finished after the mark count", () => {
  const older = entry({ id: "old", finishedAt: "2026-08-12T09:00:00.000Z" });
  const newer = entry({ id: "new", finishedAt: "2026-08-12T11:00:00.000Z" });
  const got = unseenSince([older, newer], "2026-08-12T10:00:00.000Z");
  assert.deepEqual(got.map((t) => t.id), ["new"]);
});

test("a run finishing exactly at the mark is already seen", () => {
  const at = "2026-08-12T10:00:00.000Z";
  assert.deepEqual(unseenSince([entry({ finishedAt: at })], at), []);
});

test("a run with no finish time is never unseen", () => {
  // Still in flight: it belongs to the running group, not to this one.
  assert.deepEqual(
    unseenSince([entry({ finishedAt: null })], "2026-08-12T00:00:00.000Z"),
    [],
  );
});

test("errors count as much as successes", () => {
  const failed = entry({
    id: "boom",
    status: "error",
    finishedAt: "2026-08-12T11:00:00.000Z",
  });
  assert.equal(
    unseenSince([failed], "2026-08-12T10:00:00.000Z")[0]?.id,
    "boom",
  );
});

// --- notifications -----------------------------------------------------------
// The two halves are different kinds of thing, and treating them alike is the
// easy mistake. A finished run is an event: seen once, it stops counting. A run
// blocked on a question is a standing state: glancing at the panel does not
// answer it. A badge that cleared both on sight would drop the only item that
// actually needed someone.

const activity = (
  active: ActivityEntry[] = [],
  recent: ActivityEntry[] = [],
  sandboxesRunning = 0,
) => ({ active, recent, sandboxesRunning, idleSandboxes: [] });

test("a blocked run keeps counting after it has been seen", () => {
  const blocked = entry({ id: "b", needsInput: true, status: "running" });
  const now = new Date().toISOString();
  const n = notifications(activity([blocked]), now);
  assert.equal(n.count, 1, "still counted with a fresh seen mark");
  assert.equal(n.blocked[0].id, "b");
});

test("a finished run stops counting once seen", () => {
  const done = entry({ id: "d", finishedAt: "2026-08-12T09:00:00.000Z" });
  assert.equal(notifications(activity([], [done]), "2026-08-12T10:00:00.000Z").count, 0);
  assert.equal(notifications(activity([], [done]), "2026-08-12T08:00:00.000Z").count, 1);
});

test("a seen run stays in the list, it just stops being unread", () => {
  // Reading clears the badge, not the history. A panel that empties itself
  // after one look is a panel you cannot go back to — which is exactly how
  // this first shipped.
  const done = entry({ id: "d", finishedAt: "2026-08-12T09:00:00.000Z" });
  const n = notifications(activity([], [done]), "2026-08-12T10:00:00.000Z");
  assert.equal(n.count, 0, "no longer counted");
  assert.deepEqual(n.finished.map((t) => t.id), ["d"], "still listed");
  assert.equal(n.unseenIds.has("d"), false, "and marked as read");
});

test("an unread run is listed and marked", () => {
  const done = entry({ id: "d", finishedAt: "2026-08-12T11:00:00.000Z" });
  const n = notifications(activity([], [done]), "2026-08-12T10:00:00.000Z");
  assert.equal(n.unseenIds.has("d"), true);
  assert.equal(n.count, 1);
});

test("a run still in flight never reaches the finished list", () => {
  const n = notifications(activity([], [entry({ finishedAt: null })]), null);
  assert.deepEqual(n.finished, []);
});

test("the count is both halves together", () => {
  const n = notifications(
    activity(
      [entry({ id: "b", needsInput: true })],
      [entry({ id: "d", finishedAt: "2026-08-12T11:00:00.000Z" })],
    ),
    "2026-08-12T10:00:00.000Z",
  );
  assert.equal(n.count, 2);
});

test("a running task nobody is waiting on is not a notification", () => {
  // It belongs in ⌘J, which lists work in flight; the bell is for things that
  // changed or want an answer.
  const n = notifications(activity([entry({ id: "r", needsInput: false })]), null);
  assert.equal(n.count, 0);
});

test("no data yet counts as nothing, not as a crash", () => {
  assert.equal(notifications(undefined, null).count, 0);
  assert.deepEqual(notifications(undefined, null).blocked, []);
});

// --- newlyFinished -----------------------------------------------------------
// Drives the popup + chime. The failure that matters is not missing one, it is
// announcing the same run twice, or greeting a fresh page with a chime per
// historical run — either teaches the user to ignore the thing entirely.

test("a run not announced yet is announced", () => {
  const done = entry({ id: "a" });
  assert.deepEqual(
    newlyFinished([done], new Set()).map((t) => t.id),
    ["a"],
  );
});

test("an already-announced run is not announced again", () => {
  assert.deepEqual(newlyFinished([entry({ id: "a" })], new Set(["a"])), []);
});

test("a run still in flight is never announced", () => {
  // It has no finishedAt: announcing it would fire on every poll until it ends.
  assert.deepEqual(newlyFinished([entry({ finishedAt: null })], new Set()), []);
});

test("only the unannounced ones come back from a mixed batch", () => {
  const got = newlyFinished(
    [entry({ id: "old" }), entry({ id: "new" })],
    new Set(["old"]),
  );
  assert.deepEqual(got.map((t) => t.id), ["new"]);
});

test("seeding the set with everything silences the first poll", () => {
  // This is how a page that just loaded stays quiet about history it missed.
  const recent = [entry({ id: "a" }), entry({ id: "b" })];
  const seeded = new Set(recent.map((t) => t.id));
  assert.deepEqual(newlyFinished(recent, seeded), []);
});

// --- activityCounts ----------------------------------------------------------
// The header's three numbers. "Waiting" merges two different stalls on purpose
// — blocked on a person, queued behind another run — because from across the
// room they say the same thing: nothing is moving. Only the blocked half is
// worth an alarm colour, so it is counted separately too.

test("running counts executing runs only", () => {
  const c = activityCounts(
    activity([
      entry({ id: "r", status: "running" }),
      entry({ id: "q", status: "queued" }),
      entry({ id: "b", status: "running", needsInput: true }),
    ]),
  );
  assert.equal(c.running, 1, "the queued and the blocked one are not executing");
});

test("waiting is the blocked plus the queued", () => {
  const c = activityCounts(
    activity([
      entry({ id: "q", status: "queued" }),
      entry({ id: "b", status: "running", needsInput: true }),
    ]),
  );
  assert.equal(c.waiting, 2);
  assert.equal(c.blocked, 1, "only one of them is waiting on a person");
});

test("a blocked run is never also counted as running", () => {
  // It holds a slot and looks busy, but nothing is happening in it.
  const c = activityCounts(
    activity([entry({ status: "running", needsInput: true })]),
  );
  assert.equal(c.running, 0);
  assert.equal(c.waiting, 1);
});

test("sandboxes counts every machine up, busy ones included", () => {
  const c = activityCounts(activity([entry({ status: "running" })], [], 3));
  assert.equal(c.sandboxes, 3);
});

test("no data reads as all zeros, not as a crash", () => {
  assert.deepEqual(activityCounts(undefined), {
    sandboxes: 0,
    running: 0,
    waiting: 0,
    blocked: 0,
  });
});
