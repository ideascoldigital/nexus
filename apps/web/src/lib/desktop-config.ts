/**
 * Where the installed desktop app keeps its data: `~/.nexux/native.json`.
 *
 * The Rust shell reads this file at launch (apps/native/src-tauri/src/
 * native_config.rs) and hands the sidecar the paths it names. This module is
 * the same contract from the other side, so the app can show and change it
 * instead of the user editing JSON by hand. The rules must match the Rust
 * ones: only `databasePath` and `dataDir`; each absolute or starting with
 * `~/`; a database path that is a directory is refused. Anything the Rust
 * side would refuse stops the app from launching — so this side refuses it
 * first, where the error can be shown next to the field.
 *
 * The file lives at a fixed place (not in the data dir it may move) because it
 * is what says where everything else is.
 */

import fs from "fs";
import path from "path";
import { getConfig, homeDir } from "@nexux/config";
// Client-free entry: reading a path must not construct (and migrate) Prisma.
import { databasePath } from "@nexux/db/instance-lock";

export type DesktopConfigFile = { databasePath?: string; dataDir?: string };

export type DesktopConfigView = {
  /** Where the file lives. */
  configPath: string;
  /** Its contents, or null when there is none (the app uses the defaults). */
  file: DesktopConfigFile | null;
  /** Set when the file exists but the desktop app would refuse it. */
  fileError: string | null;
  /** What the desktop app will open next launch. */
  effective: { databasePath: string; dataDir: string; databaseExists: boolean } | null;
  /** What THIS server is running on, for "use this server's database". */
  thisServer: { databasePath: string; dataDir: string; isDesktopApp: boolean };
};

export function desktopConfigPath(home: string = homeDir()): string {
  return path.join(home, ".nexux", "native.json");
}

function expandHome(raw: string, home: string): string {
  if (raw === "~") return home;
  if (raw.startsWith("~/") || raw.startsWith("~\\")) return path.join(home, raw.slice(2));
  return raw;
}

/**
 * Validate a config the way the Rust shell will, and resolve what it means.
 * Returns the resolved paths, or the message the field should show.
 */
export function resolveDesktopConfig(
  input: unknown,
  home: string = homeDir(),
): { ok: true; databasePath: string; dataDir: string } | { ok: false; error: string } {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, error: "native.json must be a JSON object." };
  }
  const obj = input as Record<string, unknown>;
  // deny_unknown_fields on the Rust side: a misspelt key there stops the
  // launch rather than silently opening the default database.
  const unknown = Object.keys(obj).filter((k) => k !== "databasePath" && k !== "dataDir");
  if (unknown.length) {
    return { ok: false, error: `Unknown key${unknown.length > 1 ? "s" : ""}: ${unknown.join(", ")}` };
  }

  const absolute = (field: string, value: unknown): string | { error: string } => {
    if (typeof value !== "string" || !value.trim()) return { error: `${field} is empty.` };
    const p = expandHome(value.trim(), home);
    if (!path.isAbsolute(p)) {
      return { error: `${field} must be an absolute path (or start with ~/).` };
    }
    return p;
  };

  const bootstrap = path.join(home, ".nexux");
  let dataDir = bootstrap;
  if (obj.dataDir !== undefined) {
    const r = absolute("dataDir", obj.dataDir);
    if (typeof r !== "string") return { ok: false, error: r.error };
    dataDir = r;
  }
  let dbPath = path.join(dataDir, "nexux.db");
  if (obj.databasePath !== undefined) {
    const r = absolute("databasePath", obj.databasePath);
    if (typeof r !== "string") return { ok: false, error: r.error };
    dbPath = r;
  }
  try {
    if (fs.statSync(dbPath).isDirectory()) {
      return { ok: false, error: "databasePath is a directory — point it at the .db file." };
    }
  } catch {
    // Not there yet is fine: the app creates it (and says so in the UI).
  }
  return { ok: true, databasePath: dbPath, dataDir };
}

export function readDesktopConfig(home: string = homeDir()): DesktopConfigView {
  const configPath = desktopConfigPath(home);
  let file: DesktopConfigFile | null = null;
  let fileError: string | null = null;
  let effective: DesktopConfigView["effective"] = null;

  let parsed: unknown = {};
  if (fs.existsSync(configPath)) {
    try {
      parsed = JSON.parse(fs.readFileSync(configPath, "utf8"));
      file = parsed as DesktopConfigFile;
    } catch (err) {
      fileError = `native.json is not valid JSON: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
  if (!fileError) {
    const r = resolveDesktopConfig(parsed, home);
    if (r.ok) {
      effective = {
        databasePath: r.databasePath,
        dataDir: r.dataDir,
        databaseExists: fs.existsSync(r.databasePath),
      };
    } else {
      fileError = r.error;
    }
  }

  return {
    configPath,
    file,
    fileError,
    effective,
    thisServer: {
      databasePath: databasePath(),
      dataDir: getConfig().dataDir,
      // Set by the desktop shell when it spawns the sidecar.
      isDesktopApp: process.env.NEXUX_SHELL === "native",
    },
  };
}

/**
 * Write the file — or remove it when nothing is overridden, so "back to the
 * defaults" leaves no file behind to misread later.
 */
export function writeDesktopConfig(
  input: DesktopConfigFile,
  home: string = homeDir(),
): { ok: true } | { ok: false; error: string } {
  const clean: DesktopConfigFile = {};
  if (input.databasePath?.trim()) clean.databasePath = input.databasePath.trim();
  if (input.dataDir?.trim()) clean.dataDir = input.dataDir.trim();

  const configPath = desktopConfigPath(home);
  if (!clean.databasePath && !clean.dataDir) {
    fs.rmSync(configPath, { force: true });
    return { ok: true };
  }
  const r = resolveDesktopConfig(clean, home);
  if (!r.ok) return r;

  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  // Write-then-rename: a half-written file would stop the next launch.
  const tmp = `${configPath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(clean, null, 2) + "\n");
  fs.renameSync(tmp, configPath);
  return { ok: true };
}
