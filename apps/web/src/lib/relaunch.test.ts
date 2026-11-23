import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { BUNDLE_ID, relaunchScript, relaunchTarget } from "./relaunch";

test("macOS reopens the bundle the sidecar runs from", () => {
  assert.equal(
    relaunchTarget("darwin", "/Applications/Nexus.app/Contents/MacOS/node"),
    "/Applications/Nexus.app",
  );
});

test("macOS quits by bundle id so the shell's exit handler kills the sidecar", () => {
  const script = relaunchScript("darwin");
  assert.ok(script.includes(`quit app id "${BUNDLE_ID}"`));
  assert.ok(script.includes('open "$2"'));
});

test("values reach the script as arguments, never interpolated", () => {
  for (const platform of ["darwin", "linux"] as const) {
    const script = relaunchScript(platform);
    assert.ok(!script.includes("/Applications/Nexus.app"), platform);
    assert.ok(script.includes('"$1"') && script.includes('"$2"'), platform);
  }
  assert.throws(() => relaunchScript("win32"), /not supported/);
});

test("the script waits for the app to exit, then starts the new build", async () => {
  // Executes the real Linux script: a stand-in "app" process to quit and a
  // stand-in "AppImage" (in a path with a space) that records it was started.
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "nexus relaunch-"));
  const marker = path.join(dir, "started");
  const appImage = path.join(dir, "Nexus App.AppImage");
  await fs.writeFile(appImage, `#!/bin/sh\necho ok > "${marker}"\n`, { mode: 0o755 });
  const app = spawn("sleep", ["30"]);
  const appExited = new Promise((r) => app.once("exit", r));

  const sh = spawn("/bin/sh", ["-c", relaunchScript("linux"), "test", String(app.pid), appImage]);
  await new Promise((r) => sh.once("exit", r));
  await appExited;

  let started = "";
  for (let i = 0; i < 40 && !started; i++) {
    started = await fs.readFile(marker, "utf8").catch(() => "");
    if (!started) await new Promise((r) => setTimeout(r, 50));
  }
  assert.equal(started.trim(), "ok", "the new build was launched after the old one quit");
  await fs.rm(dir, { recursive: true, force: true });
});
