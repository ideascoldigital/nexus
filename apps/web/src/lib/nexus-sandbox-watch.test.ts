import assert from "node:assert/strict";
import { test } from "node:test";

// The watcher reaches the database; the pure helpers tested here do not.
import "../app/api/routes.test-setup";

import { isNexusNotice, outcomeNotice, sandboxSteps } from "./nexus-sandbox-watch";

test("a sandbox's steps are its [nexux] log lines, in order", () => {
  const log = "[nexux] provisioning local container x\nnoise\n[nexux] pulling ubuntu:22.04\n[nexux] bootstrap complete — sandbox ready\n";
  assert.deepEqual(sandboxSteps(log), ["provisioning local container x", "pulling ubuntu:22.04", "bootstrap complete — sandbox ready"]);
});

test("the outcome says ready with the preview, or the error", () => {
  assert.match(outcomeNotice({ name: "s1", status: "running", previewUrl: "https://p", error: null }), /s1\*\* is up and running\. Preview: https:\/\/p/);
  assert.match(outcomeNotice({ name: "s1", status: "error", previewUrl: null, error: "docker: no space left" }), /failed to start: docker: no space left/);
  assert.ok(isNexusNotice("[nexux:notice]") && isNexusNotice("[nexux:sandbox] x") && !isNexusNotice("hola"));
});
