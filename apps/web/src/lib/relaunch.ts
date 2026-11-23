/**
 * Relaunch the native app after an update was installed.
 *
 * The UI is a web page served by this sidecar, with no Tauri IPC, so the
 * sidecar cannot ask the shell to restart. It does the next best thing: start
 * a detached script in its own session (so it outlives the app killing this
 * process on exit), quit the app the way the user would, wait for the shell
 * process — this process's parent — to be gone, and open the new bundle.
 *
 * macOS quits through AppleScript so RunEvent::Exit runs and the sidecar is
 * shut down cleanly; Linux has no such channel and gets SIGTERM. Windows is
 * not handled: there the update is an NSIS installer that closes and relaunches
 * the app itself.
 */

import { spawn } from "child_process";
import { existsSync } from "fs";
import path from "path";

/** Bundle identifier from tauri.conf.json — what AppleScript quits by. */
export const BUNDLE_ID = "com.ideascol.nexux";

/**
 * The shell script that quits `pid` and opens `target`. Pure so the exact
 * command is testable; values go in through positional args ($1, $2), never
 * interpolated, so a path with spaces or quotes cannot break out.
 */
export function relaunchScript(platform: NodeJS.Platform): string {
  const waitForExit =
    // Up to 30s for the app to finish quitting, then make sure.
    'i=0; while kill -0 "$1" 2>/dev/null && [ $i -lt 60 ]; do sleep 0.5; i=$((i+1)); done; kill -9 "$1" 2>/dev/null;';
  if (platform === "darwin") {
    return [
      "sleep 1;",
      `osascript -e 'quit app id "${BUNDLE_ID}"' >/dev/null 2>&1;`,
      waitForExit,
      'open "$2"',
    ].join(" ");
  }
  if (platform === "linux") {
    return ["sleep 1;", 'kill -TERM "$1" 2>/dev/null;', waitForExit, 'nohup "$2" >/dev/null 2>&1 &'].join(" ");
  }
  throw new Error(`relaunch is not supported on ${platform}`);
}

/**
 * What to open after quitting: the app bundle this sidecar runs from on macOS
 * (…/Nexus.app/Contents/MacOS/node → …/Nexus.app), the AppImage on Linux.
 */
export function relaunchTarget(platform: NodeJS.Platform, execPath: string): string {
  if (platform === "darwin") return path.resolve(execPath, "..", "..", "..");
  // An AppImage exports its own path; without it there is nothing to reopen.
  const appImage = process.env.APPIMAGE;
  if (!appImage) throw new Error("not running from an AppImage — relaunch Nexus by hand");
  return appImage;
}

export function relaunch(): void {
  const platform = process.platform;
  const script = relaunchScript(platform);
  let target = relaunchTarget(platform, process.execPath);
  // Running from the pre-rename Nexux.app: installing Nexus.app retired it
  // (self-update.ts installDmg), so the bundle to reopen is the new one.
  if (platform === "darwin" && !existsSync(target)) target = "/Applications/Nexus.app";
  spawn("/bin/sh", ["-c", script, "nexus-relaunch", String(process.ppid), target], {
    detached: true,
    stdio: "ignore",
  }).unref();
}
