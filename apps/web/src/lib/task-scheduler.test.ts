import assert from "node:assert/strict";
import { test } from "node:test";

// Env setup must stay above ./task-scheduler — it reaches prisma at import
// time and the client is built when the module loads.
import "./task-scheduler.test-setup";
import { computeNextRunAt, isValidCron } from "./task-scheduler";

// --- isValidCron -------------------------------------------------------------
// Guards the save form. What it rejects is what a user is told to fix; what it
// accepts is what the poller will later be handed.

test("a plain five-field cron is accepted", () => {
  assert.equal(isValidCron("0 9 * * *"), true);
});

test("steps, ranges and day names are accepted", () => {
  // All three appear in the placeholder the form suggests, so rejecting any of
  // them would reject the example we hand the user.
  assert.equal(isValidCron("*/5 * * * *"), true);
  assert.equal(isValidCron("0 9 * * 1-5"), true);
  assert.equal(isValidCron("0 9 * * MON"), true);
  assert.equal(isValidCron("*/15 9-17 * * *"), true);
});

test("the @daily family is accepted", () => {
  for (const alias of ["@daily", "@hourly", "@weekly", "@yearly"]) {
    assert.equal(isValidCron(alias), true, alias);
  }
});

test("@reboot is rejected, having no next time to compute", () => {
  // A poll-based scheduler has no reboot to fire on; accepting it would store
  // a schedule that can never produce a nextRunAt.
  assert.equal(isValidCron("@reboot"), false);
});

test("an out-of-range field is rejected", () => {
  assert.equal(isValidCron("60 * * * *"), false); // minutes stop at 59
  assert.equal(isValidCron("0 0 * * 8"), false); // weekdays stop at 7
});

test("a date that never occurs is rejected", () => {
  // April has 30 days. Stored, this schedule would simply never fire, which
  // reads as a broken scheduler rather than as a bad expression.
  assert.equal(isValidCron("0 0 31 4 *"), false);
});

test("a leap-day schedule is accepted, since it does occur", () => {
  assert.equal(isValidCron("0 0 29 2 *"), true);
});

test("prose is rejected", () => {
  assert.equal(isValidCron("not a cron"), false);
  assert.equal(isValidCron("a b c d e"), false);
});

test("whitespace alone is rejected", () => {
  assert.equal(isValidCron("   "), false);
});

test("the empty string is accepted by the parser, so callers must not rely on this alone", () => {
  // Documented rather than endorsed. cron-parser treats "" as parseable, so
  // isValidCron("") is true while computeNextRunAt({cron: ""}) ignores the
  // field entirely (it is falsy) and falls through to runAt — the two disagree.
  //
  // Nothing reaches that state today: the create route requires exactly one of
  // cron or runAt (`Boolean(d.cron) !== Boolean(d.runAt)`), which an empty cron
  // fails before this function is ever called. This test exists so that if that
  // guard is ever relaxed, the mismatch shows up here rather than as a schedule
  // that silently never fires.
  assert.equal(isValidCron(""), true);
  assert.equal(
    computeNextRunAt({ cron: "", runAt: null, lastRunAt: null }),
    null,
  );
});

// --- computeNextRunAt --------------------------------------------------------
// What the poller stores as nextRunAt. Null means "never fires again", so
// returning it by accident retires a schedule the user still expects.

test("a recurring schedule computes its next firing", () => {
  const next = computeNextRunAt({
    cron: "*/5 * * * *",
    runAt: null,
    lastRunAt: null,
  });
  assert.ok(next instanceof Date);
  assert.ok(next!.getTime() > Date.now(), "next firing is not in the future");
});

test("a recurring schedule keeps firing after it has run", () => {
  // lastRunAt retires a one-shot; it must not retire a cron.
  const next = computeNextRunAt({
    cron: "*/5 * * * *",
    runAt: null,
    lastRunAt: new Date(),
  });
  assert.ok(next !== null && next.getTime() > Date.now());
});

test("an invalid cron never fires rather than throwing", () => {
  // The poller runs this over every due row; a throw here would stop the whole
  // sweep, so one bad row would silence every other schedule.
  assert.equal(
    computeNextRunAt({ cron: "not a cron", runAt: null, lastRunAt: null }),
    null,
  );
});

test("a pending one-shot fires at its appointed time", () => {
  const runAt = new Date("2099-01-01T00:00:00.000Z");
  assert.deepEqual(
    computeNextRunAt({ cron: null, runAt, lastRunAt: null }),
    runAt,
  );
});

test("a one-shot that has already run is retired", () => {
  // Without the lastRunAt check it would be re-fired on every poll.
  assert.equal(
    computeNextRunAt({
      cron: null,
      runAt: new Date("2099-01-01T00:00:00.000Z"),
      lastRunAt: new Date("2020-01-01T00:00:00.000Z"),
    }),
    null,
  );
});

test("a one-shot whose time has passed is still returned, not skipped", () => {
  // A scheduler that was down over the appointed time should still run the
  // task late; dropping it would lose the firing silently.
  const runAt = new Date("2020-01-01T00:00:00.000Z");
  assert.deepEqual(
    computeNextRunAt({ cron: null, runAt, lastRunAt: null }),
    runAt,
  );
});

test("a schedule with neither cron nor runAt never fires", () => {
  assert.equal(
    computeNextRunAt({ cron: null, runAt: null, lastRunAt: null }),
    null,
  );
});

test("cron takes precedence over a runAt on the same row", () => {
  // The API rejects rows carrying both, so this only settles what happens to a
  // row that predates that rule: it stays recurring rather than retiring.
  const next = computeNextRunAt({
    cron: "*/5 * * * *",
    runAt: new Date("2099-01-01T00:00:00.000Z"),
    lastRunAt: new Date("2020-01-01T00:00:00.000Z"),
  });
  assert.ok(next !== null && next.getTime() < Date.parse("2099-01-01T00:00:00.000Z"));
});
