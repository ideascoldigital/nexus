import { strict as assert } from "node:assert";
import { test } from "node:test";

import { memoryLimitFromTotalBytes } from "./local";

const GB = 1024 * 1024 * 1024;

test("caps a sandbox at two thirds of what Docker has", () => {
  // Leaves room for the other sandboxes and for the engine itself.
  assert.equal(memoryLimitFromTotalBytes(8 * GB), 5461);
  assert.equal(memoryLimitFromTotalBytes(16 * GB), 10922);
});

test("a Docker too small to cap is left unlimited", () => {
  // Under ~1.5 GB the two-thirds share cannot finish a bootstrap, and a
  // container that dies during setup is worse than one that might survive.
  assert.equal(memoryLimitFromTotalBytes(1 * GB), null);
  assert.equal(memoryLimitFromTotalBytes(1.4 * GB), null);
  // Right above the floor it applies again.
  assert.equal(memoryLimitFromTotalBytes(1.6 * GB), 1092);
});

test("an unreadable total means unlimited, never a guessed number", () => {
  // `docker info` can answer empty or non-numeric; inventing a limit there
  // could be smaller than the box needs and would break every sandbox.
  assert.equal(memoryLimitFromTotalBytes(Number.NaN), null);
  assert.equal(memoryLimitFromTotalBytes(0), null);
  assert.equal(memoryLimitFromTotalBytes(-1), null);
  assert.equal(memoryLimitFromTotalBytes(Number.POSITIVE_INFINITY), null);
});
