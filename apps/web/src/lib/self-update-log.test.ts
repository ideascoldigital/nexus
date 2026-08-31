/**
 * The updater's log is append-only and every past run left a "finished" line,
 * so the card's completion signal has to be "a finished stamp I have not seen
 * before" — these tests pin the parsing that makes that comparison sound.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  lastUpdateFailed,
  lastUpdateFinished,
  lastUpdateRun,
} from "./self-update-log";

const RUN_OK = (ts: string) =>
  `[nexus-update] started ${ts}\nPulling nexux ... done\n[nexus-update] running: sha256:abc\n[nexus-update] finished ${ts}\n`;

const RUN_FAILED = (ts: string) =>
  `[nexus-update] started ${ts}\n[nexus-update] FAILED: could not pull — check the registry credentials\n[nexus-update] finished ${ts}\n`;

test("no log means no finished stamp, not a crash", () => {
  assert.equal(lastUpdateFinished(null), null);
  assert.equal(lastUpdateFinished(""), null);
  assert.equal(lastUpdateRun(null), "");
  assert.equal(lastUpdateFailed(null), false);
});

test("the finished stamp is the LAST one — past runs each left their own", () => {
  const log = RUN_OK("2026-01-01T00:00:00Z") + RUN_OK("2026-02-02T00:00:00Z");
  assert.equal(
    lastUpdateFinished(log),
    "[nexus-update] finished 2026-02-02T00:00:00Z",
  );
});

test("a run still in progress has no new finished stamp yet", () => {
  const log =
    RUN_OK("2026-01-01T00:00:00Z") + "[nexus-update] started 2026-02-02T00:00:00Z\n";
  // The poll during an update must keep seeing the OLD stamp until the new
  // run completes — this equality is what "not done yet" rests on.
  assert.equal(
    lastUpdateFinished(log),
    "[nexus-update] finished 2026-01-01T00:00:00Z",
  );
});

test("failure detection only looks at the most recent run", () => {
  // An old failure must not taint a later clean run…
  const recovered = RUN_FAILED("2026-01-01T00:00:00Z") + RUN_OK("2026-02-02T00:00:00Z");
  assert.equal(lastUpdateFailed(recovered), false);
  // …and a fresh failure is reported even after past successes.
  const regressed = RUN_OK("2026-01-01T00:00:00Z") + RUN_FAILED("2026-02-02T00:00:00Z");
  assert.equal(lastUpdateFailed(regressed), true);
});
