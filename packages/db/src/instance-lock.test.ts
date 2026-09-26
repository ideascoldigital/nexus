import { strict as assert } from "node:assert";
import { afterEach, beforeEach, test } from "node:test";
import fs from "fs";
import os from "os";
import path from "path";

import { acquireInstanceLock, describeLockConflict, lockPathFor } from "./instance-lock";

let root: string;
let dbPath: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "nexux-lock-"));
  dbPath = path.join(root, "nexux.db");
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

test("the first server takes the lock and releases it", () => {
  const res = acquireInstanceLock(dbPath, { pid: 100, origin: "http://localhost:3333" });
  assert.ok(res.ok);
  const held = JSON.parse(fs.readFileSync(lockPathFor(dbPath), "utf8"));
  assert.equal(held.pid, 100);
  assert.equal(held.origin, "http://localhost:3333");
  res.release();
  assert.equal(fs.existsSync(lockPathFor(dbPath)), false);
});

test("a second server is refused while the first is alive, and told where it is", () => {
  const first = acquireInstanceLock(dbPath, { pid: 100, origin: "http://localhost:3333", alive: () => true });
  assert.ok(first.ok);
  const second = acquireInstanceLock(dbPath, { pid: 200, origin: "http://127.0.0.1:3030", alive: () => true });
  assert.equal(second.ok, false);
  if (second.ok) return;
  assert.equal(second.holder.pid, 100);
  const msg = describeLockConflict(second);
  assert.match(msg, /at http:\/\/localhost:3333 \(pid 100\)/);
  assert.match(msg, /delete .*nexux\.db\.lock/);
});

test("a lock left by a dead process is taken over", () => {
  acquireInstanceLock(dbPath, { pid: 100 });
  const res = acquireInstanceLock(dbPath, { pid: 200, alive: (pid) => pid !== 100 });
  assert.ok(res.ok);
  assert.equal(JSON.parse(fs.readFileSync(lockPathFor(dbPath), "utf8")).pid, 200);
});

test("an unreadable lock file is stale, not a reason to refuse forever", () => {
  fs.writeFileSync(lockPathFor(dbPath), "{not json");
  const res = acquireInstanceLock(dbPath, { pid: 200, alive: () => true });
  assert.ok(res.ok);
});

test("the same process asking again keeps it", () => {
  acquireInstanceLock(dbPath, { pid: 100 });
  assert.ok(acquireInstanceLock(dbPath, { pid: 100, alive: () => true }).ok);
});

test("release never removes someone else's lock", () => {
  const mine = acquireInstanceLock(dbPath, { pid: 100 });
  assert.ok(mine.ok);
  // Taken over after we were presumed dead.
  fs.writeFileSync(lockPathFor(dbPath), JSON.stringify({ pid: 300, origin: null, startedAt: "" }));
  mine.release();
  assert.equal(JSON.parse(fs.readFileSync(lockPathFor(dbPath), "utf8")).pid, 300);
});

test("the real liveness check sees this process as alive", () => {
  const first = acquireInstanceLock(dbPath, { pid: process.pid });
  assert.ok(first.ok);
  const second = acquireInstanceLock(dbPath, { pid: process.pid + 1_000_000 });
  assert.equal(second.ok, false);
});
