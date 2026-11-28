import assert from "node:assert/strict";
import { test } from "node:test";

import { elapsedLabel, sandboxPhase } from "./sandbox-phase";

test("before the machine runs its setup, the launcher's last step", () => {
  const log = "· provisioning local container x · pulling ubuntu:22.04 · creating container x";
  assert.equal(sandboxPhase(log, null), "Creating container x");
  assert.equal(sandboxPhase("", ""), null);
});

test("inside the machine, its last [nexux] step — warnings and apt noise skipped", () => {
  const boot = [
    "[nexux] bootstrap started 2026-11-27T21:00:00",
    "[nexux] installing Node.js 22",
    "Unpacking xfonts-utils (1:7.7+6build2) ...",
    "[nexux] cloning simplifybot-api",
    "[nexux] WARN: install failed for simplifybot-ui",
  ].join("\n");
  assert.equal(sandboxPhase("· bootstrap started — tail …", boot), "Cloning simplifybot-api");
  assert.equal(sandboxPhase("", "[nexux] bootstrap started 2026-11-27"), "Starting the setup");
});

test("elapsed time reads short", () => {
  const now = Date.parse("2026-11-27T21:10:00Z");
  assert.equal(elapsedLabel("2026-11-27T21:09:15Z", now), "45s");
  assert.equal(elapsedLabel("2026-11-27T21:06:55Z", now), "3m 05s");
  assert.equal(elapsedLabel("2026-11-27T20:08:00Z", now), "1h 02m");
});
