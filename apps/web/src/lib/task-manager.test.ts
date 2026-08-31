import assert from "node:assert/strict";
import fs from "node:fs";
import { after, afterEach, test } from "node:test";

// Env setup must stay above ./task-manager — it reaches prisma at import time
// and the client is built when the module loads.
import { testDbDir } from "./task-manager.test-setup";
import {
  acquireSandboxLock,
  isSandboxBusy,
  releaseSandboxLock,
} from "./task-manager";

/** Sandbox ids are unique per test so a leak cannot pass as a pass. */
let counter = 0;
const held: string[] = [];
const sandboxId = () => {
  const id = `sbx-${++counter}`;
  held.push(id);
  return id;
};

afterEach(() => {
  // The lock set is module-global; drop anything a test left behind.
  for (const id of held) releaseSandboxLock(id);
  held.length = 0;
});

after(() => {
  fs.rmSync(testDbDir, { recursive: true, force: true });
});

test("an untouched sandbox is not busy", () => {
  assert.equal(isSandboxBusy(sandboxId()), false);
});

test("acquiring reports success and marks the sandbox busy", () => {
  const id = sandboxId();
  assert.equal(acquireSandboxLock(id), true);
  assert.equal(isSandboxBusy(id), true);
});

test("a second acquire is refused while the first is held", () => {
  // This is the whole point of the lock: two Claude runs in one checkout
  // would fight over the working tree.
  const id = sandboxId();
  assert.equal(acquireSandboxLock(id), true);
  assert.equal(acquireSandboxLock(id), false);
  assert.equal(acquireSandboxLock(id), false);
});

test("a refused acquire does not disturb the held lock", () => {
  const id = sandboxId();
  acquireSandboxLock(id);
  acquireSandboxLock(id);
  assert.equal(isSandboxBusy(id), true);
});

test("releasing frees the sandbox", () => {
  const id = sandboxId();
  acquireSandboxLock(id);
  releaseSandboxLock(id);
  assert.equal(isSandboxBusy(id), false);
});

test("a released sandbox can be acquired again", () => {
  // drainQueue loops: release then re-acquire on the next queued task.
  const id = sandboxId();
  acquireSandboxLock(id);
  releaseSandboxLock(id);
  assert.equal(acquireSandboxLock(id), true);
});

test("locks are held per sandbox, not globally", () => {
  const a = sandboxId();
  const b = sandboxId();
  assert.equal(acquireSandboxLock(a), true);
  assert.equal(acquireSandboxLock(b), true);
  assert.equal(isSandboxBusy(a), true);
  assert.equal(isSandboxBusy(b), true);
});

test("releasing one sandbox leaves the others held", () => {
  const a = sandboxId();
  const b = sandboxId();
  acquireSandboxLock(a);
  acquireSandboxLock(b);
  releaseSandboxLock(a);
  assert.equal(isSandboxBusy(a), false);
  assert.equal(isSandboxBusy(b), true);
});

test("releasing a lock nobody holds is a no-op", () => {
  // `finally { releaseSandboxLock() }` runs even on paths that never acquired.
  const id = sandboxId();
  assert.doesNotThrow(() => releaseSandboxLock(id));
  assert.equal(isSandboxBusy(id), false);
});

test("releasing twice does not leave the sandbox acquirable-but-busy", () => {
  const id = sandboxId();
  acquireSandboxLock(id);
  releaseSandboxLock(id);
  releaseSandboxLock(id);
  assert.equal(isSandboxBusy(id), false);
  assert.equal(acquireSandboxLock(id), true);
});

test("one release frees the sandbox regardless of refused acquires", () => {
  // A refused acquire must not have incremented anything: the lock is a flag,
  // not a counter, so the single owner's release fully frees it.
  const id = sandboxId();
  acquireSandboxLock(id);
  acquireSandboxLock(id);
  acquireSandboxLock(id);
  releaseSandboxLock(id);
  assert.equal(isSandboxBusy(id), false);
});

test("ids are compared exactly, not by prefix", () => {
  const id = sandboxId();
  acquireSandboxLock(id);
  assert.equal(isSandboxBusy(`${id}-suffix`), false);
  assert.equal(acquireSandboxLock(`${id}-suffix`), true);
  held.push(`${id}-suffix`);
});

test("the empty string is a distinct sandbox id", () => {
  assert.equal(isSandboxBusy(""), false);
  assert.equal(acquireSandboxLock(""), true);
  held.push("");
  assert.equal(isSandboxBusy(""), true);
});

test("the lock survives a re-import of the module", async () => {
  // sandbox-manager.pauseSandbox does `await import("./task-manager")` to read
  // isSandboxBusy; a per-module Set instead of the globalThis one would let a
  // paused sandbox be yanked out from under a running task.
  const id = sandboxId();
  acquireSandboxLock(id);
  const reimported = await import("./task-manager");
  assert.equal(reimported.isSandboxBusy(id), true);
  assert.equal(reimported.acquireSandboxLock(id), false);
});

test("a release through a re-imported module frees the original lock", () => {
  const id = sandboxId();
  acquireSandboxLock(id);
  const globalSet = (
    globalThis as unknown as { nexuxTaskOps: Set<string> | undefined }
  ).nexuxTaskOps;
  assert.ok(globalSet, "locks are kept on globalThis");
  assert.equal(globalSet.has(id), true);
  releaseSandboxLock(id);
  assert.equal(globalSet.has(id), false);
});

test("an acquire/run/release cycle leaves no residue", () => {
  // The drainQueue + runDevTask shape: acquire, work, release in `finally`.
  const id = sandboxId();
  assert.equal(acquireSandboxLock(id), true);
  try {
    assert.throws(() => {
      throw new Error("task blew up");
    });
  } finally {
    releaseSandboxLock(id);
  }
  assert.equal(isSandboxBusy(id), false);
  assert.equal(acquireSandboxLock(id), true);
});

test("only one of many concurrent contenders wins the lock", async () => {
  const id = sandboxId();
  const results = await Promise.all(
    Array.from({ length: 8 }, async () => acquireSandboxLock(id))
  );
  assert.equal(results.filter(Boolean).length, 1);
  assert.equal(isSandboxBusy(id), true);
});
