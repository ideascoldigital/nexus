import { strict as assert } from "node:assert";
import { test } from "node:test";

import { createHarness } from "./harness";

test("warm lifecycle is rejected until P1", () => {
  assert.throws(() => createHarness({ lifecycle: "warm" }), /warm lifecycle/);
});

test("ephemeral harness is created with partial config", () => {
  const h = createHarness({ image: "alpine:3", memoryMb: 512 });
  assert.equal(typeof h.sandbox, "function");
  assert.equal(typeof h.shutdown, "function");
});

test("shutdown with no live sandboxes resolves", async () => {
  const h = createHarness();
  await h.shutdown();
});
