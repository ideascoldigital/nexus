import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  LOCK_VERSION,
  describeLock,
  diffLocks,
  summarizeChanges,
  type StackLockData,
} from "./lock";

function lock(over: Partial<StackLockData> = {}): StackLockData {
  return {
    lockVersion: LOCK_VERSION,
    provider: "local",
    source: "mount",
    sandboxId: "sbx1",
    repos: [
      {
        name: "api",
        repositoryId: "r1",
        commit: "a1b2c3d4e5f6",
        dirty: false,
        lockfile: "pnpm-lock.yaml",
        lockfileSha256: "9f86d081884c",
      },
    ],
    services: [
      {
        name: "postgres",
        image: "postgres:17",
        digest: "sha256:1a2b3c4d",
        healthcheck: true,
      },
    ],
    tooling: { node: "22.11.0", pnpm: "9.12.3" },
    ...over,
  };
}

test("a mounted run against a dirty tree says so", () => {
  // The sentence the whole field exists for: this booted against files that
  // exist on exactly one machine.
  const l = lock({
    repos: [{ ...lock().repos[0], dirty: true }],
  });
  const text = describeLock(l);
  assert.match(text, /uncommitted/);
  assert.match(text, /cloud sandbox clones/);
});

test("a mounted run against a clean tree still warns about cloning", () => {
  const text = describeLock(lock());
  assert.match(text, /all committed/);
  // Clean is not the same as reproducible elsewhere — a mount never proves it.
  assert.match(text, /may still differ/);
});

test("a cloned run claims the stronger thing", () => {
  const text = describeLock(lock({ source: "clone", provider: "civo" }));
  assert.match(text, /civo/);
  assert.match(text, /cloned at the recorded commits/);
  assert.doesNotMatch(text, /uncommitted/);
});

test("repo counts read naturally in both numbers", () => {
  assert.match(describeLock(lock()), /1 repo,/);
  const two = lock({
    repos: [lock().repos[0], { ...lock().repos[0], name: "web", repositoryId: "r2" }],
  });
  assert.match(describeLock(two), /2 repos/);
});

test("nothing changed between identical locks", () => {
  assert.deepEqual(diffLocks(lock(), lock()), []);
});

test("a moved commit is reported short", () => {
  const after = lock({
    repos: [{ ...lock().repos[0], commit: "ffffffffffff" }],
  });
  const changes = diffLocks(lock(), after);
  assert.equal(changes.length, 1);
  assert.deepEqual(changes[0], {
    kind: "repo",
    name: "api",
    field: "commit",
    before: "a1b2c3d",
    after: "fffffff",
  });
});

test("a changed lockfile is reported even when the commit holds", () => {
  // Happens constantly with a mount: the tree moved, the commit did not.
  const after = lock({
    repos: [{ ...lock().repos[0], lockfileSha256: "0000000000" }],
  });
  const changes = diffLocks(lock(), after);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].field, "pnpm-lock.yaml");
});

test("becoming dirty is its own change", () => {
  // "But nothing changed" — the commit really is identical, and the tree is not.
  const after = lock({ repos: [{ ...lock().repos[0], dirty: true }] });
  const changes = diffLocks(lock(), after);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].field, "uncommitted changes");
  assert.equal(changes[0].before, "no");
  assert.equal(changes[0].after, "yes");
});

test("an image that moved underneath an unchanged tag is caught", () => {
  // The invisible regression. postgres:17 today is not postgres:17 last week,
  // and without the digest there is nothing to point at.
  const after = lock({
    services: [{ ...lock().services[0], digest: "sha256:deadbeef" }],
  });
  const changes = diffLocks(lock(), after);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].kind, "service");
  assert.equal(changes[0].field, "postgres:17 digest");
});

test("a changed image reports the image, not the digest", () => {
  // Both changed, but the tag is the cause and the digest is its consequence.
  const after = lock({
    services: [
      { ...lock().services[0], image: "postgres:18", digest: "sha256:deadbeef" },
    ],
  });
  const changes = diffLocks(lock(), after);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].field, "image");
  assert.equal(changes[0].before, "postgres:17");
  assert.equal(changes[0].after, "postgres:18");
});

test("added and removed repos both count as changes", () => {
  const after = lock({
    repos: [
      lock().repos[0],
      {
        name: "worker",
        repositoryId: "r2",
        commit: "bbbbbbbbbbbb",
        dirty: false,
        lockfile: null,
        lockfileSha256: null,
      },
    ],
  });
  assert.equal(diffLocks(lock(), after).filter((c) => c.field === "added").length, 1);
  assert.equal(diffLocks(after, lock()).filter((c) => c.field === "removed").length, 1);
});

test("a service that vanished explains a failure as well as one that changed", () => {
  const after = lock({ services: [] });
  const changes = diffLocks(lock(), after);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].field, "removed");
  assert.equal(changes[0].before, "postgres:17");
});

test("tooling drift is reported, including a tool that disappeared", () => {
  const after = lock({ tooling: { node: "24.0.0" } });
  const changes = diffLocks(lock(), after);
  const fields = changes.map((c) => `${c.name}:${c.before}→${c.after}`);
  assert.deepEqual(fields, ["node:22.11.0→24.0.0", "pnpm:9.12.3→null"]);
});

test("a null digest does not read as a change against another null", () => {
  // Docker absent on both runs. "We do not know" twice is not drift.
  const a = lock({ services: [{ ...lock().services[0], digest: null }] });
  assert.deepEqual(diffLocks(a, a), []);
});

test("an empty diff says so in words", () => {
  assert.match(summarizeChanges([]), /Nothing changed/);
});

test("a long diff is truncated with a count", () => {
  const before = lock();
  const after = lock({
    repos: [{ ...lock().repos[0], commit: "f".repeat(12), dirty: true, lockfileSha256: "0" }],
    services: [{ ...lock().services[0], image: "postgres:18" }],
    tooling: { node: "24.0.0" },
  });
  const changes = diffLocks(before, after);
  assert.ok(changes.length > 3, `expected >3 changes, got ${changes.length}`);
  const text = summarizeChanges(changes);
  assert.match(text, /and \d+ more/);
});
