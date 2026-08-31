import assert from "node:assert/strict";
import fs from "node:fs";
import { after, test } from "node:test";

// Env setup must stay above ./sandbox-process-manager — it reaches prisma at
// import time and the client is built when the module loads.
import { testDbDir } from "./sandbox-process-manager.test-setup";
import {
  pidProbeCandidates,
  reconcileRowState,
  type ProcessRowState,
} from "./sandbox-process-manager";

after(() => {
  fs.rmSync(testDbDir, { recursive: true, force: true });
});

const row = (over: Partial<ProcessRowState> = {}): ProcessRowState => ({
  key: "node-web#0",
  status: "running",
  role: "run",
  pid: 1234,
  previewUrl: null,
  ...over,
});

test("a run process whose PID died is reconciled to stopped", async () => {
  const r = reconcileRowState(row(), new Set());
  assert.deepEqual(r, { status: "stopped", pid: null, previewUrl: null, flip: true });
});

test("a run process still alive keeps its state", async () => {
  const r = reconcileRowState(
    row({ previewUrl: "https://x.trycloudflare.com" }),
    new Set(["node-web#0"]),
  );
  assert.deepEqual(r, {
    status: "running",
    pid: 1234,
    previewUrl: "https://x.trycloudflare.com",
    flip: false,
  });
});

test("an unreachable sandbox keeps the stored state untouched", async () => {
  // "Cannot ask" is not the same as "not running".
  const r = reconcileRowState(row(), null);
  assert.equal(r.status, "running");
  assert.equal(r.flip, false);
});

test("a row that is already stopped is left alone", async () => {
  const r = reconcileRowState(row({ status: "stopped", pid: null }), new Set());
  assert.deepEqual(r, { status: "stopped", pid: null, previewUrl: null, flip: false });
});

test("a starting process that never came up is reconciled too", async () => {
  const r = reconcileRowState(row({ status: "starting" }), new Set());
  assert.equal(r.status, "stopped");
  assert.equal(r.flip, true);
});

test("no stored row means stopped, with nothing to flip", async () => {
  const r = reconcileRowState(undefined, new Set());
  assert.deepEqual(r, { status: "stopped", pid: null, previewUrl: null, flip: false });
});

test("a launcher stays running after its shell exits", async () => {
  // The `make up` case: the launcher detaches docker containers and its own
  // PID dies by design. A dead launcher PID says nothing about the services
  // it brought up, so the row must NOT be reconciled to stopped.
  const r = reconcileRowState(
    row({ key: "node-stack#0", role: "services", pid: null }),
    new Set(),
  );
  assert.equal(r.status, "running");
  assert.equal(r.flip, false);
});

test("only run-role rows are probed by PID", async () => {
  const candidates = pidProbeCandidates([
    row(),
    row({ key: "node-stack#0", role: "services" }),
    row({ key: "node-fn#0", status: "stopped" }),
    row({ key: "node-api#0", status: "starting" }),
  ]);
  assert.deepEqual(
    candidates.map((r) => r.key),
    ["node-web#0", "node-api#0"],
  );
});
