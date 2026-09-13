import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";

import { isLocalTarget, renderNavigateScript } from "./browser-cdp";

// --- isLocalTarget -----------------------------------------------------------
// A security boundary, not a validation nicety: the session is a browser with
// unrestricted access to the instance's localhost, so anything that could point
// it elsewhere turns it into a fetcher for whoever reaches the route.

test("the sandbox's own services are allowed", () => {
  assert.ok(isLocalTarget("http://localhost:3000"));
  assert.ok(isLocalTarget("http://127.0.0.1:8000/api/health"));
  assert.ok(isLocalTarget("https://localhost:8443"));
  assert.ok(isLocalTarget("http://[::1]:3000"));
});

test("external origins are refused", () => {
  assert.ok(!isLocalTarget("http://example.com"));
  assert.ok(!isLocalTarget("https://169.254.169.254/latest/meta-data/"));
  assert.ok(!isLocalTarget("http://localhost.evil.com"));
  assert.ok(!isLocalTarget("http://notlocalhost"));
});

test("non-http schemes are refused", () => {
  // file:// would read the instance's disk through the browser; the others are
  // simply not things a session should be pointed at.
  assert.ok(!isLocalTarget("file:///etc/passwd"));
  assert.ok(!isLocalTarget("chrome://settings"));
  assert.ok(!isLocalTarget("javascript:alert(1)"));
  assert.ok(!isLocalTarget("data:text/html,<h1>x"));
});

test("garbage is refused rather than thrown on", () => {
  assert.ok(!isLocalTarget(""));
  assert.ok(!isLocalTarget("localhost:3000")); // no scheme: not a URL
  assert.ok(!isLocalTarget("not a url at all"));
});

// --- renderNavigateScript ----------------------------------------------------

test("the CDP call stays on loopback", () => {
  const script = renderNavigateScript(9222, "http://localhost:3000");
  assert.match(script, /http:\/\/127\.0\.0\.1:9222\/json\/new/);
  assert.ok(!script.includes("0.0.0.0"));
});

test("a URL with shell metacharacters cannot break out", () => {
  const nasty = "http://localhost:3000/'; touch /tmp/pwned; echo '";
  const script = renderNavigateScript(9222, nasty);
  // Run the quoted expansion through a real bash rather than regex-matching
  // it: what matters is that the shell produces the URL and executes nothing.
  const printf = script.match(/printf '%s' ('.*?')(?= \|)/s)![0];
  const out = execFileSync("bash", ["-c", printf], { encoding: "utf8" });
  assert.equal(out, nasty);
});

test("characters that would split the query are encoded", () => {
  const script = renderNavigateScript(9222, "http://localhost:3000/?a=1&b=2#f");
  const pipeline = script.match(/printf[\s\S]*?\)/)![0].replace(/\)$/, "");
  const out = execFileSync("bash", ["-c", pipeline], { encoding: "utf8" });
  // & would start a second parameter and # would truncate the URL at the
  // fragment, so CDP would open something other than what was typed.
  assert.ok(!out.includes("&"), `& survived: ${out}`);
  assert.ok(!out.includes("#"), `# survived: ${out}`);
  assert.match(out, /%26/);
  assert.match(out, /%23/);
});
