import { strict as assert } from "node:assert";
import { test } from "node:test";

import { memoryLimitFromTotalBytes, parseDockerPort } from "./local";

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

test("the 1024 MB floor is inclusive", () => {
  // 1.5 GB is exactly two-thirds of 1024 MB, the smallest cap considered
  // survivable. An exclusive check here would push this box to unlimited and
  // move the real floor somewhere nobody wrote down.
  assert.equal(memoryLimitFromTotalBytes(1536 * 1024 * 1024), 1024);
  assert.equal(memoryLimitFromTotalBytes(1535 * 1024 * 1024), null);
});

test("the cap is a whole number of megabytes", () => {
  // Passed to `docker run --memory=<n>m`, which rejects a fractional value.
  for (const total of [2 * GB, 3 * GB, 6 * GB, 12 * GB, 64 * GB]) {
    const mb = memoryLimitFromTotalBytes(total);
    assert.ok(mb !== null && Number.isInteger(mb), `${total} gave ${mb}`);
  }
});

test("the cap never exceeds what Docker actually has", () => {
  // A limit above the engine's own total would not protect anything.
  for (const total of [2 * GB, 8 * GB, 64 * GB]) {
    const mb = memoryLimitFromTotalBytes(total)!;
    assert.ok(mb < total / 1024 / 1024, `${total} gave ${mb}`);
  }
});

test("the published host port is read off the end of the line", () => {
  // `docker port` prints one binding per line, and an IPv6 address carries
  // colons of its own — splitting on ":" would take the wrong field.
  assert.equal(parseDockerPort("0.0.0.0:49154\n"), 49154);
  assert.equal(parseDockerPort("127.0.0.1:32770"), 32770);
  assert.equal(parseDockerPort("[::]:49154"), 49154);
  // Both families bound: either answers, so the first is enough.
  assert.equal(parseDockerPort("127.0.0.1:32770\n[::1]:32771\n"), 32770);
});

test("a container with no such binding yields no port", () => {
  // `docker port` prints nothing when the port was never published, and a
  // guessed port would connect the panel to whatever else is listening.
  assert.equal(parseDockerPort(""), null);
  assert.equal(parseDockerPort("\n"), null);
  assert.equal(parseDockerPort("Error: No public port"), null);
  // Out of range is not a port.
  assert.equal(parseDockerPort("127.0.0.1:99999"), null);
  assert.equal(parseDockerPort("127.0.0.1:0"), null);
});
