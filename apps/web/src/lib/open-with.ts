// "Open in …" for a project's folder (spec 39): Finder (or the OS file
// manager), Cursor or VS Code, whichever this machine has. Pure parts here;
// the route spawns.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const OPENERS = ["finder", "cursor", "vscode", "zed"] as const;
export type OpenerId = (typeof OPENERS)[number];

const MAC_APPS: Record<Exclude<OpenerId, "finder">, string> = {
  cursor: "Cursor.app",
  vscode: "Visual Studio Code.app",
  zed: "Zed.app",
};
const CLI: Record<Exclude<OpenerId, "finder">, string> = { cursor: "cursor", vscode: "code", zed: "zed" };

/** Which openers this machine has. Finder always. */
export function availableOpeners(platform = process.platform, home = os.homedir()): OpenerId[] {
  const found: OpenerId[] = ["finder"];
  for (const id of ["cursor", "vscode", "zed"] as const) {
    if (platform === "darwin") {
      const app = MAC_APPS[id];
      if (fs.existsSync(path.join("/Applications", app)) || fs.existsSync(path.join(home, "Applications", app))) found.push(id);
    } else {
      const dirs = (process.env.PATH ?? "").split(path.delimiter);
      if (dirs.some((d) => fs.existsSync(path.join(d, CLI[id])) || fs.existsSync(path.join(d, `${CLI[id]}.cmd`)))) found.push(id);
    }
  }
  return found;
}

/** The argv that opens `dir` with an editor. Pure; null for Finder (the OS opener). */
export function editorCommand(id: Exclude<OpenerId, "finder">, dir: string, platform = process.platform): string[] {
  if (platform === "darwin") return ["open", "-a", MAC_APPS[id].replace(/\.app$/, ""), dir];
  return [CLI[id], dir];
}

const FINDER_APP = "/System/Library/CoreServices/Finder.app";

/** The installed app's bundle on macOS, or null. */
export function macAppBundle(id: OpenerId, home = os.homedir()): string | null {
  if (id === "finder") return fs.existsSync(FINDER_APP) ? FINDER_APP : null;
  for (const dir of ["/Applications", path.join(home, "Applications")]) {
    const bundle = path.join(dir, MAC_APPS[id]);
    if (fs.existsSync(bundle)) return bundle;
  }
  return null;
}

/** The bundle's .icns (CFBundleIconFile, with or without its extension), or null. */
export function iconFileIn(bundle: string, iconFile: string | null): string | null {
  const resources = path.join(bundle, "Contents", "Resources");
  const names = iconFile ? [iconFile.endsWith(".icns") ? iconFile : `${iconFile}.icns`] : [];
  names.push(`${path.basename(bundle, ".app")}.icns`);
  for (const name of names) {
    const file = path.join(resources, name);
    if (fs.existsSync(file)) return file;
  }
  return null;
}

/**
 * The argv that opens one file (at a line) with `id`. Pure. VS Code and Cursor
 * take a line through their URL scheme; Finder reveals the file; Zed opens it.
 */
export function openFileCommand(
  id: OpenerId,
  file: string,
  pos: { line?: number; column?: number } = {},
  platform = process.platform,
): string[] {
  const at = pos.line ? `:${pos.line}${pos.column ? `:${pos.column}` : ""}` : "";
  if (id === "finder") return platform === "darwin" ? ["open", "-R", file] : ["xdg-open", path.dirname(file)];
  if (platform === "darwin" && (id === "vscode" || id === "cursor")) {
    return ["open", `${id}://file${encodeURI(file)}${at}`];
  }
  if (platform !== "darwin" && (id === "vscode" || id === "cursor")) return [CLI[id], "-g", `${file}${at}`];
  return editorCommand(id, file, platform);
}
