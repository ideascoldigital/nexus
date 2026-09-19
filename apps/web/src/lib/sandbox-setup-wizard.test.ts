import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  applyWizardParams,
  resolveDestination,
  resolveStep,
  restoreWizardState,
  stepsFor,
} from "./sandbox-setup-wizard";

// The setup drawer restores itself from the URL. These cover what a reload is
// supposed to bring back: not just which step is open, but the answers the
// earlier steps are showing — the part that used to be silently dropped.

test("cloud destinations get the Machine step, local does not", () => {
  assert.deepEqual(
    stepsFor("civo").map((s) => s.key),
    ["type", "machine", "code", "tooling", "agent", "launch"],
  );
  assert.deepEqual(
    stepsFor("aws").map((s) => s.key),
    ["type", "machine", "code", "tooling", "agent", "launch"],
  );
  assert.deepEqual(
    stepsFor("local").map((s) => s.key),
    ["type", "code", "tooling", "agent", "launch"],
  );
});

// ---- destination ----

test("a destination in the URL is restored over the saved provider", () => {
  // The URL records what the user last picked in this drawer, which is not
  // necessarily what the project has saved.
  assert.equal(resolveDestination("local", "civo"), "local");
  assert.equal(resolveDestination("local", "aws"), "local");
  assert.equal(resolveDestination("aws", "civo"), "aws");
  assert.equal(resolveDestination("civo", "aws"), "civo");
});

test("without a URL destination it falls back to the saved provider", () => {
  assert.equal(resolveDestination(null, "aws"), "aws");
  assert.equal(resolveDestination(null, "civo"), "civo");
  // SandboxConfig stores "local" now, and launchSandbox branches on it, so a
  // project that runs in a container must reopen in one — coercing it to Civo
  // showed a destination the project had not chosen.
  assert.equal(resolveDestination(null, "local"), "local");
});

test("an unknown or missing provider falls back to civo", () => {
  assert.equal(resolveDestination(null, null), "civo");
  assert.equal(resolveDestination(null, undefined), "civo");
  assert.equal(resolveDestination(null, "hetzner"), "civo");
});

test("a garbage destination in the URL is ignored, not trusted", () => {
  assert.equal(resolveDestination("banana", "aws"), "aws");
  assert.equal(resolveDestination("", "aws"), "aws");
  assert.equal(resolveDestination("LOCAL", "civo"), "civo");
});

// ---- step ----

test("a valid step for the destination is restored as-is", () => {
  assert.equal(resolveStep("code", "civo"), "code");
  assert.equal(resolveStep("launch", "local"), "launch");
  assert.equal(resolveStep("machine", "aws"), "machine");
});

test("a step hidden by the destination advances instead of resetting", () => {
  // Regression: findIndex returned -1 and Math.max(0, …) sent the user back to
  // step 1, discarding the progress the stepper still shows.
  assert.equal(resolveStep("machine", "local"), "code");
});

test("an unknown step starts the wizard over", () => {
  assert.equal(resolveStep("banana", "civo"), "type");
  assert.equal(resolveStep(null, "local"), "type");
  assert.equal(resolveStep(undefined, "aws"), "type");
  assert.equal(resolveStep("", "civo"), "type");
});

// ---- both together ----

test("a refreshed local wizard comes back local, on the same step", () => {
  assert.deepEqual(
    restoreWizardState("?sandboxSetup=1&sandboxStep=tooling&sandboxTarget=local", "civo"),
    { destination: "local", step: "tooling" },
  );
});

test("the destination resolves before the step it filters", () => {
  // ?sandboxStep=machine is only invalid *because* the target is local — the
  // order matters, so assert the combination rather than each half.
  assert.deepEqual(
    restoreWizardState("?sandboxStep=machine&sandboxTarget=local", "aws"),
    { destination: "local", step: "code" },
  );
  // Same step key, cloud target: kept.
  assert.deepEqual(
    restoreWizardState("?sandboxStep=machine&sandboxTarget=aws", "civo"),
    { destination: "aws", step: "machine" },
  );
});

test("a first visit with no params starts at type on the saved provider", () => {
  assert.deepEqual(restoreWizardState("", "aws"), {
    destination: "aws",
    step: "type",
  });
});

test("a step restored without a destination uses the saved provider's steps", () => {
  // Links shared before ?sandboxTarget= existed still resolve sensibly.
  assert.deepEqual(restoreWizardState("?sandboxStep=machine", "civo"), {
    destination: "civo",
    step: "machine",
  });
});

// ---- writing back ----

test("opening writes all three params", () => {
  const url = applyWizardParams("https://app.test/projects/p1", {
    open: true,
    step: "agent",
    destination: "local",
  });
  const params = new URL(url).searchParams;
  assert.equal(params.get("sandboxSetup"), "1");
  assert.equal(params.get("sandboxStep"), "agent");
  assert.equal(params.get("sandboxTarget"), "local");
});

test("closing drops only the open flag", () => {
  // The editor stays mounted behind the close animation, so clearing the step
  // and target here would make reopening look like a reset.
  const url = applyWizardParams(
    "https://app.test/p1?sandboxSetup=1&sandboxStep=code&sandboxTarget=local",
    { open: false, step: "code", destination: "local" },
  );
  const params = new URL(url).searchParams;
  assert.equal(params.get("sandboxSetup"), null);
  assert.equal(params.get("sandboxStep"), "code");
  assert.equal(params.get("sandboxTarget"), "local");
});

test("unrelated query params survive", () => {
  const url = applyWizardParams("https://app.test/p1?tab=sandboxes&q=x", {
    open: true,
    step: "type",
    destination: "civo",
  });
  const params = new URL(url).searchParams;
  assert.equal(params.get("tab"), "sandboxes");
  assert.equal(params.get("q"), "x");
});

test("writing then restoring round-trips", () => {
  for (const destination of ["local", "civo", "aws"] as const) {
    for (const step of stepsFor(destination)) {
      const url = applyWizardParams("https://app.test/p1", {
        open: true,
        step: step.key,
        destination,
      });
      assert.deepEqual(
        restoreWizardState(new URL(url).search, "civo"),
        { destination, step: step.key },
        `${destination}/${step.key} should survive a round-trip`,
      );
    }
  }
});
