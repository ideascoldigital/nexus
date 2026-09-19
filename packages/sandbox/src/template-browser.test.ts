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
  const section = renderBrowserInstallSection("nexus");
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

test("a container widens the bridge, and nothing else", () => {
  // Docker forwards a published port to the container's own interface, so a
  // bridge on 127.0.0.1 answers nobody and the panel gets a 1006 close. The
  // boundary there is `-p 127.0.0.1::6080` on the host side.
  const script = renderBrowserStartScript({
    token: TOKEN,
    wsAllInterfaces: true,
  });
  assert.match(script, /websockify 0\.0\.0\.0:\d+ 127\.0\.0\.1:\d+/);
  // The VNC server and CDP stay loopback whatever the bridge does: VNC is
  // reached *through* the bridge, and an open CDP port is remote code
  // execution against every origin the browser can see.
  assert.match(script, /x11vnc[\s\S]*?-localhost/);
  assert.match(script, /--remote-debugging-address=127\.0\.0\.1/);
  assert.match(script, /Xvfb[\s\S]*?-nolisten tcp/);
});

test("the widened bind is opt-in, never the default", () => {
  // A cloud instance has no published-port boundary — the bind address is the
  // whole of it, and "every interface" there means the public one.
  assert.doesNotMatch(renderBrowserStartScript({ token: TOKEN }), /0\.0\.0\.0/);
  assert.doesNotMatch(
    renderBrowserStartScript({ token: TOKEN, wsAllInterfaces: false }),
    /0\.0\.0\.0/,
  );
});

test("the VNC password never reaches a command line or the trace", () => {
  const script = renderBrowserStartScript({ token: TOKEN });
  // /proc/<pid>/cmdline is world-readable, so `x11vnc -passwd <secret>` would
  // publish the password to every user on the instance.
  assert.doesNotMatch(script, new RegExp(`-passwd\\s+${TOKEN}`));
  assert.match(script, /-passwdfile/);
  // xtrace is on for the rest of the bootstrap; the token must sit inside a
  // set +x / set -x window.
  const at = script.indexOf(TOKEN);
  assert.ok(at > 0, "the token should appear exactly once, in the passwd write");
  assert.equal(script.indexOf(TOKEN, at + 1), -1);
  const before = script.slice(0, at);
  assert.ok(
    before.lastIndexOf("set +x") > before.lastIndexOf("set -x"),
    "the token must be written with xtrace off",
  );
});

test("the stored password is the token, not a literal dash", () => {
  // `x11vnc -storepasswd - <file>` reads like "take the password from stdin"
  // and does not: x11vnc stores the literal "-" and never reads stdin, so
  // every session authenticated against a dash while the panel was handed a
  // token that could not work. -passwdfile takes the plaintext from the file.
  const script = renderBrowserStartScript({ token: TOKEN });
  assert.doesNotMatch(script, /-storepasswd/);
  assert.match(script, new RegExp(`echo '${TOKEN}' >`));
  // The write must reach the same file x11vnc is told to read.
  const wrote = script.match(/> (\S*vncpasswd)/)?.[1];
  const reads = script.match(/-passwdfile (\S*vncpasswd)/)?.[1];
  assert.ok(wrote && reads, "the password is written and read back");
  assert.equal(wrote, reads);
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
  const probe = script.indexOf("ws_answers");
  assert.ok(probe > 0 && probe < marker, "probe must precede the marker");
  assert.match(script, /READY:\d+:\d+/);
  assert.match(script, /WS_FAILED/);
});

test("the readiness probe does not treat an HTTP error status as down", () => {
  // websockify answers a plain GET with 405 — it wants an upgrade handshake.
  // `curl -f` exits 22 on any 4xx, so a probe carrying -f reports every
  // healthy bridge as WS_FAILED and the session never comes up.
  const script = renderBrowserStartScript({ token: TOKEN });
  const start = script.indexOf("ws_answers()");
  assert.ok(start > 0, "the probe is a named function");
  // The Xvfb wait uses the same loop header earlier in the script, so the end
  // anchor has to be the one that follows the function, not the first match.
  const probe = script.slice(
    start,
    script.indexOf("for i in $(seq 1 30)", start),
  );
  assert.ok(probe.includes("curl"), "the probe still uses curl");
  // No -f in any of curl's flag clusters (-fs, -sf, --fail).
  assert.doesNotMatch(probe, /curl[^\n]*(-[A-Za-z]*f|--fail)/);
});

test("the session directory is not world-readable", () => {
  // It holds the VNC password file and the profile.
  assert.match(
    renderBrowserInstallSection("nexus"),
    new RegExp(`chmod 700 ${BROWSER_DIR}`),
  );
  assert.match(renderBrowserStartScript({ token: TOKEN }), /chmod 600/);
});

test("the session directory belongs to the user that writes in it", () => {
  // The bootstrap is root and the session script is the agent user: a
  // root-owned 0700 directory fails every write the session makes, and the
  // first casualty is the log that would have said so.
  const section = renderBrowserInstallSection("nexus");
  assert.match(section, new RegExp(`chown 'nexus':'nexus' ${BROWSER_DIR}`));
  // Ownership before the mode, or the chmod applies to a directory the agent
  // user does not own yet.
  assert.ok(
    section.indexOf("chown") < section.indexOf("chmod 700"),
    "chown must precede chmod",
  );
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
  // write must emit the token verbatim and execute nothing.
  const write = script.match(/^echo (.*) > \S*vncpasswd$/m);
  assert.ok(write, "the password write is a single echo to the passwd file");
  const out = execFileSync("bash", ["-c", `echo ${write[1]}`], {
    encoding: "utf8",
  });
  // echo adds the newline -passwdfile expects; the token itself is intact.
  assert.equal(out, `${nasty}\n`);
});

test("parseBrowserStart reads the ports back, or reports nothing", () => {
  assert.deepEqual(parseBrowserStart("noise\nREADY:6080:9222\n"), {
    wsPort: 6080,
    cdpPort: 9222,
  });
  assert.equal(parseBrowserStart("WS_FAILED\ntail..."), null);
  assert.equal(parseBrowserStart(""), null);
});
