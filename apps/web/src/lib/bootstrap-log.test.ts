import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  HIGHLIGHT_LINES,
  TAIL_LINES,
  bootstrapLogCommand,
  parseBootstrapLog,
} from "./bootstrap-log";

// Executes the generated shell in a real bash. On Windows `bash` resolves to
// C:\Windows\System32\bash.exe — the WSL launcher, not a shell: it re-parses
// argv and rewrites paths on the way into the distro, so the temp files these
// assert against do not exist as written. The command only ever runs on Linux.
const realBash = {
  skip:
    process.platform === "win32" &&
    "`bash` here is the WSL launcher, which re-parses argv",
};

/**
 * The command as the instance really sees it: through `bash -lc`, which is what
 * execRemote does. Asserting on the command *string* would not have caught the
 * bug this covers — an unquoted sentinel that bash read as a here-string, so it
 * aborted after line one and returned a tail that looked entirely normal.
 */
function run(logPath: string): string {
  return execFileSync("bash", ["-lc", bootstrapLogCommand(logPath)], {
    encoding: "utf8",
  });
}

function fixture(lines: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-bootlog-"));
  const file = path.join(dir, "nexus-bootstrap.log");
  fs.writeFileSync(file, lines);
  return file;
}

const AUTH_URL = "https://vpn.example.com/oidc/register/mkey:abc123";

test("the command survives bash in one piece", realBash, () => {
  // Every line has to run: the failure mode is a partial execution that still
  // returns output, which reads as "the log has no warnings" rather than as a
  // broken command.
  const out = run(
    fixture(
      [
        "[nexux] bootstrap started",
        "[nexux] WARN: tailscale install failed",
        "Setting up some-package ...",
        "[nexux] bootstrap finished 2026-08-05T22:10:25+00:00",
      ].join("\n") + "\n",
    ),
  );
  const view = parseBootstrapLog(out);
  assert.equal(view.complete, true);
  assert.ok(view.log.includes("Setting up some-package"));
  assert.deepEqual(view.warnings, ["[nexux] WARN: tailscale install failed"]);
});

test("a WARN above the tail window still comes back", realBash, () => {
  // The whole point. A real bootstrap is ~1500 lines and its install failures
  // are in the first third — one sandbox lost tailscale, cloudflared, gh and
  // glab to a single dpkg lock, none of it visible from the app.
  const early = "[nexux] WARN: tailscale install failed";
  const log =
    [early, ...Array.from({ length: TAIL_LINES + 200 }, (_, i) => `line ${i}`)].join("\n") +
    "\n";
  const view = parseBootstrapLog(run(fixture(log)));
  assert.ok(!view.log.includes(early), "the fixture does not push it out of the tail");
  assert.deepEqual(view.warnings, [early]);
});

test("a registration URL out of the tail is still reachable", realBash, () => {
  const log =
    [
      `[nexux] tailscale-auth-url=${AUTH_URL}`,
      ...Array.from({ length: TAIL_LINES + 50 }, (_, i) => `line ${i}`),
    ].join("\n") + "\n";
  const view = parseBootstrapLog(run(fixture(log)));
  assert.equal(view.tailscaleAuthUrl, AUTH_URL);
});

test("the highlight scan is bounded", realBash, () => {
  const log =
    Array.from(
      { length: HIGHLIGHT_LINES + 40 },
      (_, i) => `[nexux] WARN: failure ${i}`,
    ).join("\n") + "\n";
  const view = parseBootstrapLog(run(fixture(log)));
  assert.equal(view.warnings.length, HIGHLIGHT_LINES);
  // Kept the last ones: on a run that failed repeatedly, the most recent are
  // the ones still true.
  assert.equal(
    view.warnings.at(-1),
    `[nexux] WARN: failure ${HIGHLIGHT_LINES + 39}`,
  );
});

test("a log that does not exist yet is reported, not an error", realBash, () => {
  const view = parseBootstrapLog(run("/nonexistent/nexus-bootstrap.log"));
  assert.ok(view.log.includes("bootstrap log not created yet"));
  assert.equal(view.complete, false);
  assert.deepEqual(view.warnings, []);
});

test("a log that prints the sentinel itself cannot forge highlights", () => {
  // Untrusted text: a repo's build output can echo anything. The split takes
  // the last occurrence — the one the command appended — so a planted one ends
  // up inside the tail, where it is inert.
  const forged = "===nexus-bootstrap-highlights===";
  const view = parseBootstrapLog(
    `build output\n${forged}\n[nexux] WARN: forged\n${forged}\n[nexux] WARN: real\n`,
  );
  assert.deepEqual(view.warnings, ["[nexux] WARN: real"]);
  assert.ok(view.log.includes("[nexux] WARN: forged"));
});

test("output with no sentinel at all degrades to the tail", () => {
  // An ssh that died mid-stream, or an older instance. Better a log with no
  // highlights than an empty panel.
  const view = parseBootstrapLog("just some output\n[nexux] bootstrap finished\n");
  assert.ok(view.log.includes("just some output"));
  assert.equal(view.complete, true);
  assert.deepEqual(view.warnings, []);
  assert.equal(view.tailscaleAuthUrl, null);
});

test("an empty log reads as empty rather than blank", () => {
  assert.equal(parseBootstrapLog("").log, "(empty)");
});
