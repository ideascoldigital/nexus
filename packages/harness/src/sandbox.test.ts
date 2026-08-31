// Smoke test — needs Docker running. Skips cleanly if not.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHarness, dockerAvailable } from "./index";

test("verify loop: write -> exec -> read", async (t) => {
  if (!(await dockerAvailable())) {
    t.skip("docker not available");
    return;
  }

  const harness = createHarness({ image: "node:20-bookworm" });
  const sb = await harness.sandbox();
  try {
    // exit code + struct result
    const echo = await sb.exec("echo hello");
    assert.equal(echo.exitCode, 0);
    assert.equal(echo.stdout.trim(), "hello");

    // nonzero exit captured, not thrown
    const fail = await sb.exec("exit 3");
    assert.equal(fail.exitCode, 3);

    // file IO round-trip
    await sb.writeFile("greeting.txt", "hi there");
    const read = await sb.readFile("greeting.txt");
    assert.equal(read, "hi there");

    // network none by default
    const net = await sb.exec("getent hosts example.com || echo NONET");
    assert.match(net.stdout, /NONET/);

    // timeout -> 124
    const slow = await sb.exec("sleep 5", { timeoutMs: 500 });
    assert.equal(slow.exitCode, 124);
    assert.equal(slow.timedOut, true);
  } finally {
    await sb.destroy();
    await harness.shutdown();
  }
});
