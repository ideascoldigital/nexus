import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";

import {
  BROWSER_DIR,
  BROWSER_READY_MARKER,
  isValidDimension,
  isValidDisplay,
  isValidPort,
  parseBrowserStart,
  renderBrowserInstallSection,
  renderBrowserStartScript,
  renderBrowserStopScript,
} from "./template-browser";

const TOKEN = "s3cr3tPW";

test("the install section adds no browser of its own", () => {
  const section = renderBrowserInstallSection();
  // Chromium comes from installAgentBrowser; a second install would mean two
  // builds to keep current and two paths to get wrong.
  assert.doesNotMatch(section, /chromium|playwright|google-chrome/i);
  assert.match(section, /xvfb/);
  assert.match(section, /x11vnc/);
  assert.match(section, /websockify/);
});

test("every listener is pinned to loopback", () => {
  const script = renderBrowserStartScript({ token: TOKEN });
  // The dashboard arrives over an SSH forward. Anything on a public interface
  // here is a browser with unrestricted localhost access, handed to whoever
  // finds the port.
  assert.match(script, /x11vnc[\s\S]*?-localhost/);
  assert.match(script, /--remote-debugging-address=127\.0\.0\.1/);
  assert.match(script, /websockify 127\.0\.0\.1:\d+ 127\.0\.0\.1:\d+/);
  assert.match(script, /Xvfb[\s\S]*?-nolisten tcp/);
  assert.doesNotMatch(script, /0\.0\.0\.0/);
});

test("the VNC password never reaches a command line or the trace", () => {
  const script = renderBrowserStartScript({ token: TOKEN });
  // /proc/<pid>/cmdline is world-readable, so `x11vnc -passwd <secret>` would
  // publish the password to every user on the instance.
  assert.doesNotMatch(script, new RegExp(`-passwd\\s+${TOKEN}`));
  assert.match(script, /-storepasswd/);
  assert.match(script, /-rfbauth/);
  // xtrace is on for the rest of the bootstrap; the token must sit inside a
  // set +x / set -x window.
  const at = script.indexOf(TOKEN);
  assert.ok(at > 0, "the token should appear exactly once, in the storepasswd pipe");
  assert.equal(script.indexOf(TOKEN, at + 1), -1);
  const before = script.slice(0, at);
  assert.ok(
    before.lastIndexOf("set +x") > before.lastIndexOf("set -x"),
    "the token must be written with xtrace off",
  );
});

test("kills are by recorded PID, never by pattern", () => {
  const stop = renderBrowserStopScript();
  // The script's own command line names what it launches, so a pkill -f would
  // match the shell running it.
  assert.doesNotMatch(stop, /pkill|killall/);
  assert.match(stop, /kill "\$\(cat "\$p"\)"/);
  for (const proc of ["websockify", "x11vnc", "chromium", "xvfb"]) {
    assert.ok(stop.includes(proc), `stop should cover ${proc}`);
  }
});

test("starting again replaces the previous session", () => {
  const script = renderBrowserStartScript({ token: TOKEN });
  // One browser per sandbox: a restart must not leave an orphan holding :99.
  assert.match(script, /kill "\$\(cat "\$f"\)"/);
  assert.ok(script.indexOf("kill") < script.indexOf("Xvfb"));
  // A stale ready marker would report the old session as the new one.
  assert.ok(
    script.indexOf(`rm -f ${BROWSER_READY_MARKER}`) < script.indexOf("Xvfb"),
  );
});

test("ready is reported only once the forwarded port answers", () => {
  const script = renderBrowserStartScript({ token: TOKEN });
  const marker = script.indexOf(`touch ${BROWSER_READY_MARKER}`);
  const probe = script.indexOf("curl -fs");
  assert.ok(probe > 0 && probe < marker, "probe must precede the marker");
  assert.match(script, /READY:\d+:\d+/);
  assert.match(script, /WS_FAILED/);
});

test("the session directory is not world-readable", () => {
  // It holds the VNC password file and the profile.
  assert.match(renderBrowserInstallSection(), new RegExp(`chmod 700 ${BROWSER_DIR}`));
  assert.match(renderBrowserStartScript({ token: TOKEN }), /chmod 600/);
});

test("values that reach the shell are validated", () => {
  assert.ok(isValidDisplay(":99"));
  assert.ok(!isValidDisplay(":99; rm -rf /"));
  assert.ok(!isValidDisplay("99"));
  assert.ok(isValidPort(6080));
  assert.ok(!isValidPort(80), "privileged ports need root and are not offered");
  assert.ok(!isValidPort(70000));
  assert.ok(isValidDimension(1440));
  assert.ok(!isValidDimension(0));

  assert.throws(() => renderBrowserStartScript({ token: TOKEN, display: ":9; id" }));
  assert.throws(() => renderBrowserStartScript({ token: TOKEN, vncPort: 22 }));
  assert.throws(() => renderBrowserStartScript({ token: TOKEN, width: -1 }));
  assert.throws(
    () => renderBrowserStartScript({ token: "" }),
    /needs a VNC password/,
  );
});

test("the three ports must differ", () => {
  // Two services on one port means the second dies silently and the session
  // reports up with half of itself missing.
  assert.throws(
    () => renderBrowserStartScript({ token: TOKEN, wsPort: 5900, vncPort: 5900 }),
    /must differ/,
  );
});

test("a token with shell metacharacters cannot break out", () => {
  const nasty = `'; touch /tmp/pwned; echo '`;
  const script = renderBrowserStartScript({ token: nasty });
  // Run the quoting through a real bash rather than regex-matching it: the
  // printf must emit the token verbatim and execute nothing.
  const out = execFileSync(
    "bash",
    ["-c", script.match(/printf '%s' ('.*?')(?= \|)/s)![0] ?? ""],
    { encoding: "utf8" },
  );
  assert.equal(out, nasty);
});

test("parseBrowserStart reads the ports back, or reports nothing", () => {
  assert.deepEqual(parseBrowserStart("noise\nREADY:6080:9222\n"), {
    wsPort: 6080,
    cdpPort: 9222,
  });
  assert.equal(parseBrowserStart("WS_FAILED\ntail..."), null);
  assert.equal(parseBrowserStart(""), null);
});
