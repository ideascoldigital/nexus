import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  assertStepName,
  bootstrapReportCommand,
  failedSteps,
  parseBootstrapReport,
  renderStepHelpers,
  stepChain,
  BOOTSTRAP_REPORT_PATH,
  type BootstrapStep,
} from "./bootstrap-report";

// The helpers are bash, so they are tested by running bash — the same choice
// template.test.ts makes, and for the same reason: a quoting bug is invisible
// to a string assertion and obvious to a shell.
const bashAvailable = (() => {
  if (process.platform === "win32") return false;
  try {
    execFileSync("bash", ["-c", "true"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

/**
 * Runs the helpers plus `script` in a real bash, with SANDBOX_ROOT redirected
 * into a temp dir, and returns the report lines it produced.
 */
function runHelpers(script: string): {
  stdout: string;
  report: string;
} {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-report-"));
  const reportPath = path.join(dir, "bootstrap-report.jsonl");
  const source = [
    "set -u",
    // The real preamble defines this; the helpers call it on a fatal step.
    'nexus_bootstrap_fatal() { echo "FATAL:$1"; }',
    renderStepHelpers()
      .split(BOOTSTRAP_REPORT_PATH)
      .join(reportPath)
      .split("mkdir -p /opt/nexus 2>/dev/null || true")
      .join(`mkdir -p ${dir} 2>/dev/null || true`),
    script,
  ].join("\n");

  const stdout = execFileSync("bash", ["-c", source], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const report = fs.existsSync(reportPath)
    ? fs.readFileSync(reportPath, "utf8")
    : "";
  fs.rmSync(dir, { recursive: true, force: true });
  return { stdout, report };
}

test("parseBootstrapReport reads well-formed lines", () => {
  const raw = [
    '{"step":"apt:base","severity":"warn","exitCode":0,"durationMs":1200,"at":"2026-09-21T10:00:00Z"}',
    '{"step":"clone:api","severity":"fatal","exitCode":128,"durationMs":900,"at":"2026-09-21T10:00:02Z"}',
  ].join("\n");

  const { steps, malformed } = parseBootstrapReport(raw);
  assert.equal(malformed.length, 0);
  assert.equal(steps.length, 2);
  assert.equal(steps[1].step, "clone:api");
  assert.equal(steps[1].severity, "fatal");
  assert.equal(steps[1].exitCode, 128);
});

test("a truncated final line is kept as malformed, earlier steps survive", () => {
  // The case the format exists for: the box died mid-append.
  const raw =
    '{"step":"apt:base","severity":"warn","exitCode":0,"durationMs":5,"at":"x"}\n' +
    '{"step":"install:api","severity":"war';

  const { steps, malformed } = parseBootstrapReport(raw);
  assert.equal(steps.length, 1);
  assert.equal(steps[0].step, "apt:base");
  assert.equal(malformed.length, 1);
});

test("parseBootstrapReport rejects lines missing the required fields", () => {
  const { steps, malformed } = parseBootstrapReport(
    '{"severity":"warn","exitCode":0}\n{"step":"ok","exitCode":0}',
  );
  assert.equal(steps.length, 1);
  assert.equal(steps[0].step, "ok");
  assert.equal(malformed.length, 1);
});

test("failedSteps keeps the latest record for a repeated step", () => {
  // What the retry action produces: the same step, run again, now green.
  const report = parseBootstrapReport(
    [
      '{"step":"clone:api","severity":"warn","exitCode":128,"durationMs":1,"at":"a"}',
      '{"step":"install:api","severity":"warn","exitCode":1,"durationMs":1,"at":"b"}',
      '{"step":"clone:api","severity":"warn","exitCode":0,"durationMs":1,"at":"c"}',
    ].join("\n"),
  );

  const failed = failedSteps(report).map((s: BootstrapStep) => s.step);
  assert.deepEqual(failed, ["install:api"]);
});

test("assertStepName refuses names the recorder cannot encode", () => {
  assert.equal(assertStepName("install:api"), "install:api");
  assert.equal(assertStepName("apt:base"), "apt:base");
  for (const bad of ['boot:"api"', "clone:a\\b", "", "has space", "ñ"]) {
    assert.throws(() => assertStepName(bad), /Invalid bootstrap step name/);
  }
});

test("bootstrapReportCommand never fails on a missing file", () => {
  const cmd = bootstrapReportCommand("/nope/missing.jsonl");
  if (!bashAvailable) return;
  const out = execFileSync("bash", ["-c", cmd], { encoding: "utf8" });
  assert.equal(out, "");
});

test("nexus_step records a success", { skip: !bashAvailable }, () => {
  const { report } = runHelpers(`nexus_step "apt:base" warn true`);
  const { steps } = parseBootstrapReport(report);
  assert.equal(steps.length, 1);
  assert.equal(steps[0].step, "apt:base");
  assert.equal(steps[0].exitCode, 0);
  assert.match(steps[0].at, /^\d{4}-\d{2}-\d{2}T/);
});

test("nexus_step records a failure without aborting", { skip: !bashAvailable }, () => {
  const { stdout, report } = runHelpers(
    `nexus_step "install:api" warn bash -c 'exit 3'\necho "still running"`,
  );
  const { steps } = parseBootstrapReport(report);
  assert.equal(steps[0].exitCode, 3);
  assert.equal(steps[0].severity, "warn");
  // The whole point of D-33: a failed step does not end the bootstrap.
  assert.match(stdout, /still running/);
});

test("a fatal step calls nexus_bootstrap_fatal", { skip: !bashAvailable }, () => {
  const { stdout, report } = runHelpers(
    `nexus_step "clone:api" fatal bash -c 'exit 128'`,
  );
  assert.match(stdout, /FATAL:clone:api/);
  assert.equal(parseBootstrapReport(report).steps[0].severity, "fatal");
});

test("a failing warn step does not call nexus_bootstrap_fatal", { skip: !bashAvailable }, () => {
  const { stdout } = runHelpers(`nexus_step "tailscale:install" warn bash -c 'exit 1'`);
  assert.doesNotMatch(stdout, /FATAL/);
});

test("stepChain keeps the existing WARN echo and records", { skip: !bashAvailable }, () => {
  const chain = stepChain(
    "install:api",
    "warn",
    `bash -c 'exit 7'`,
    `echo "[nexux] WARN: install failed for api"`,
  );
  const { stdout, report } = runHelpers(chain);

  // The log line the UI tails must survive — replacing one signal with the
  // other would be a regression for anyone reading along.
  assert.match(stdout, /\[nexux\] WARN: install failed for api/);
  const { steps } = parseBootstrapReport(report);
  assert.equal(steps[0].step, "install:api");
  assert.equal(steps[0].exitCode, 7);
});

test("stepChain skips the failure branch when the command succeeds", { skip: !bashAvailable }, () => {
  const { stdout, report } = runHelpers(
    stepChain("install:api", "warn", "true", `echo "SHOULD NOT PRINT"`),
  );
  assert.doesNotMatch(stdout, /SHOULD NOT PRINT/);
  assert.equal(parseBootstrapReport(report).steps[0].exitCode, 0);
});

test("nested stepChain calls report their own durations", { skip: !bashAvailable }, () => {
  // The bug `local` prevents: an inner step overwriting the outer step's start
  // time produces a plausible, wrong duration rather than an error.
  const inner = stepChain("install:api", "warn", "sleep 0.05", "true");
  const outer = stepChain(
    "repo:setup",
    "warn",
    `bash -c ${JSON.stringify(`:`)}; ${inner}; sleep 0.05`,
    "true",
  );
  const { report } = runHelpers(outer);
  const { steps } = parseBootstrapReport(report);

  const innerStep = steps.find((s) => s.step === "install:api");
  const outerStep = steps.find((s) => s.step === "repo:setup");
  assert.ok(innerStep && outerStep);
  // The outer step contains the inner one plus its own sleep, so it must be
  // the longer of the two. A shared global would make them near-identical.
  assert.ok(
    outerStep.durationMs >= innerStep.durationMs,
    `outer ${outerStep.durationMs}ms should be >= inner ${innerStep.durationMs}ms`,
  );
});

test("a command with quotes survives stepChain", { skip: !bashAvailable }, () => {
  const { stdout, report } = runHelpers(
    stepChain(
      "install:api",
      "warn",
      `bash -c 'echo "it'"'"'s fine"'`,
      `echo "WARN"`,
    ),
  );
  assert.match(stdout, /it's fine/);
  assert.equal(parseBootstrapReport(report).steps[0].exitCode, 0);
});
