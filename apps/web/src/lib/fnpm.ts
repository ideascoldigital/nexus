// fnpm (github.com/ideascoldigital/fnpm) — the default way to install and run
// a JS repository on this Mac (spec 39): it keeps the repo's own lockfile and
// audits packages before they land. Nexus uses it when it is installed.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const PMS = ["npm", "pnpm", "yarn", "bun", "deno"] as const;
export type PackageManager = (typeof PMS)[number];

let cached: { at: number; path: string | null } | null = null;

/** Where fnpm is installed, or null: on PATH, or its installer's ~/.local/bin. */
export function fnpmPath(): string | null {
  if (cached && Date.now() - cached.at < 60_000) return cached.path;
  const dirs = [...(process.env.PATH ?? "").split(path.delimiter), path.join(os.homedir(), ".local", "bin")];
  const found = dirs.map((d) => path.join(d, "fnpm")).find((f) => {
    try {
      fs.accessSync(f, fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
  cached = { at: Date.now(), path: found ?? null };
  return cached.path;
}

/**
 * The one-line command that installs and runs a repository's script through
 * fnpm: set it up once (with the repo's own package manager, so its lockfile
 * stays the source of truth), then install and run. Pure.
 */
export function fnpmRunCommand(pm: string, script: string, install = true): string {
  const manager = (PMS as readonly string[]).includes(pm) ? pm : "npm";
  const run = `fnpm run ${script}`;
  return `[ -d .fnpm ] || fnpm setup ${manager}; ${install ? `fnpm install && ${run}` : run}`;
}
