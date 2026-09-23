import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { parseBootstrapReport, renderStepHelpers } from "./bootstrap-report";
import {
  bootProbeLogPath,
  renderBootProbe,
  renderBootProbeHelper,
  renderStepTailHelper,
  BOOT_PROBE_TIMEOUT_SECONDS,
} from "./boot-probe";

// The probe is bash that starts a process, polls a port and kills a process
// group. None of that can be asserted from the string — a wrong kill leaves a
// port held, which is exactly the bug it exists to prevent — so it is run.
const realBash = (() => {
  if (process.platform === "win32") return false;
  try {
    execFileSync("bash", ["-c", "command -v curl && command -v python3"], {
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
})();

/**
 * Runs a probe in a real bash, with `runuser` stubbed (the test is not root)
 * and the report redirected into a temp file.
 */
function runProbe(
  probe: string,
  opts: { timeoutSeconds?: number } = {},
): { stdout: string; report: string; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-boot-"));
  const reportPath = path.join(dir, "report.jsonl");
  const redirect = (s: string) =>
    s.split("/opt/nexus/bootstrap-report.jsonl").join(reportPath);

  let helper = redirect(renderBootProbeHelper("nexus"));
  if (opts.timeoutSeconds !== undefined) {
    helper = helper.replace(
      `-lt ${BOOT_PROBE_TIMEOUT_SECONDS}`,
      `-lt ${opts.timeoutSeconds}`,
    );
  }

  const source = [
    "set -u",
    'nexus_bootstrap_fatal() { echo "FATAL:$1"; }',
    redirect(renderStepHelpers()),
    redirect(renderStepTailHelper()),
    // Not root in a test: drop the `-u <user> --` prefix and exec the rest,
    // which is already `bash -lc "<command>"`.
    'runuser() { shift 3; "$@"; }',
    helper,
    probe,
  ].join("\n");

  const stdout = execFileSync("bash", ["-c", source], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const report = fs.existsSync(reportPath)
    ? fs.readFileSync(reportPath, "utf8")
    : "";
  return { stdout, report, dir };
}

/** A tiny HTTP server as a shell command, for the "it boots" case. */
function serverCommand(port: number, delaySeconds = 0): string {
  return `sleep ${delaySeconds}; python3 -m http.server ${port} --bind 127.0.0.1`;
}

/** A port nothing else on this machine is using. */
function freePort(): number {
  // 41000+ is comfortably outside the ephemeral range on both macOS and Linux.
  return 41000 + Math.floor(Math.random() * 2000);
}

test("renderBootProbe passes every argument through shq", () => {
  const out = renderBootProbe({
    name: "api",
    cwd: "/opt/nexus/it's here",
    command: `pnpm dev --flag "x"`,
    port: 3000,
  });
  // The cwd's apostrophe must not end the quoted argument.
  assert.match(out, /'\/opt\/nexus\/it'\\''s here'/);
  assert.match(out, /nexus_boot_probe 'boot:api' 'api'/);
});

test("a repo name that is not a valid step name is refused at render time", () => {
  // Better a throw here than a report line the parser silently drops.
  assert.throws(
    () =>
      renderBootProbe({
        name: 'bad"name',
        cwd: "/x",
        command: "true",
        port: 1,
      }),
    /Invalid bootstrap step name/,
  );
});

test("an app that answers is recorded as a pass", { skip: !realBash }, () => {
  const port = freePort();
  const { stdout, report } = runProbe(
    renderBootProbe({
      name: "api",
      cwd: os.tmpdir(),
      command: serverCommand(port),
      port,
    }),
  );

  assert.match(stdout, /api answered on port/);
  const { steps } = parseBootstrapReport(report);
  assert.equal(steps.length, 1);
  assert.equal(steps[0].step, "boot:api");
  assert.equal(steps[0].exitCode, 0);
});

test("the app is stopped afterwards, so the port is free", { skip: !realBash }, () => {
  // The probe proves the app boots; it must not hand over a running app. A
  // leaked process would hold the port and make the user's own Start fail
  // with EADDRINUSE on a sandbox that had just "passed".
  const port = freePort();
  const { stdout } = runProbe(
    renderBootProbe({
      name: "api",
      cwd: os.tmpdir(),
      command: serverCommand(port),
      port,
    }),
  );

  // Assert it came up first. Without this the test passes when the launch
  // silently fails — "the port is free" is trivially true for a server that
  // never started, which is exactly how a missing setsid hid for one run.
  assert.match(stdout, /answered on port/, "the app never started");

  // Give the kill a moment to be reaped, then the port must be reusable.
  const stillUp = execFileSync(
    "bash",
    [
      "-c",
      `sleep 1; curl -s -o /dev/null --max-time 2 "http://localhost:${port}" && echo UP || echo DOWN`,
    ],
    { encoding: "utf8" },
  ).trim();
  assert.equal(stillUp, "DOWN", "the probe left the app running");
});

test("the kill reaches a child the command spawned", { skip: !realBash }, () => {
  // The real case: `pnpm dev` spawns the server as a child, so killing the
  // recorded PID alone leaves the port held by an orphan. setsid + kill on the
  // process group is what covers it.
  const port = freePort();
  const { stdout } = runProbe(
    renderBootProbe({
      name: "api",
      cwd: os.tmpdir(),
      // A wrapper that outlives nothing: the server is a grandchild.
      command: `bash -c 'python3 -m http.server ${port} --bind 127.0.0.1' & wait`,
      port,
    }),
  );
  assert.match(stdout, /answered on port/, "the app never started");

  const stillUp = execFileSync(
    "bash",
    [
      "-c",
      `sleep 1; curl -s -o /dev/null --max-time 2 "http://localhost:${port}" && echo UP || echo DOWN`,
    ],
    { encoding: "utf8" },
  ).trim();
  assert.equal(stillUp, "DOWN", "a spawned child survived the probe");
});

test("an app that never answers fails, with its output attached", { skip: !realBash }, () => {
  const port = freePort();
  const { stdout, report } = runProbe(
    renderBootProbe({
      name: "web",
      cwd: os.tmpdir(),
      command: `echo "Error: Cannot find module '@/generated/prisma'"; exit 1`,
      port,
    }),
    { timeoutSeconds: 6 },
  );

  assert.match(stdout, /boot probe failed for web/);
  const { steps } = parseBootstrapReport(report);
  assert.equal(steps[0].step, "boot:web");
  assert.notEqual(steps[0].exitCode, 0);
  // The tail is what makes the failure actionable: "did not answer on port
  // 3000" alone says nothing about why.
  assert.ok(steps[0].tail, "the failure carries no log tail");
  assert.match(steps[0].tail!, /Cannot find module/);
});

test("a dead process is not waited on for the full timeout", { skip: !realBash }, () => {
  // The command exits immediately; the probe must notice rather than poll a
  // port nothing will ever answer for three minutes.
  const port = freePort();
  const started = Date.now();
  const { stdout } = runProbe(
    renderBootProbe({
      name: "api",
      cwd: os.tmpdir(),
      command: "exit 1",
      port,
    }),
    { timeoutSeconds: 60 },
  );
  const elapsed = Date.now() - started;

  assert.match(stdout, /exited before answering/);
  assert.ok(elapsed < 30_000, `waited ${elapsed}ms for a dead process`);
});

test("output with quotes and newlines survives into the report", { skip: !realBash }, () => {
  // A build error routinely contains quotes and backslashes; an unescaped one
  // would produce a line the parser drops — silently, which is the failure
  // mode this whole spec exists to remove.
  const port = freePort();
  const { report } = runProbe(
    renderBootProbe({
      name: "api",
      cwd: os.tmpdir(),
      command: `printf 'he said "hi"\\nC:\\\\path\\\\x\\n'; exit 1`,
      port,
    }),
    { timeoutSeconds: 6 },
  );

  const { steps, malformed } = parseBootstrapReport(report);
  assert.deepEqual(malformed, [], "the tail broke the JSON line");
  assert.match(steps[0].tail!, /he said "hi"/);
  assert.match(steps[0].tail!, /C:\\path\\x/);
});

test("a missing directory is skipped, not failed", { skip: !realBash }, () => {
  // A repo whose clone failed has no checkout; reporting its boot as broken
  // would be a second failure for one cause.
  const { stdout, report } = runProbe(
    renderBootProbe({
      name: "api",
      cwd: "/nope/not/here",
      command: "true",
      port: freePort(),
    }),
  );
  assert.match(stdout, /boot probe skipped/);
  assert.equal(parseBootstrapReport(report).steps.length, 0);
});

test("the log path is per-app, so two probes cannot overwrite each other", () => {
  assert.notEqual(bootProbeLogPath("api"), bootProbeLogPath("web"));
});
