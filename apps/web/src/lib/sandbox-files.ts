// Reading a sandbox's files for the project chat's Files surface (spec 39).
// Read-only: list one folder, or read the head of one file. Paths are checked
// and shell-quoted — the command runs through a shell on the machine.

import path from "node:path";

export const SANDBOX_ROOT = "/opt/nexus";
export const MAX_FILE_BYTES = 256 * 1024;

/** A path the Files surface may ask for: absolute, no NULs, normalised. Null otherwise. Pure. */
export function cleanSandboxPath(raw: string | null | undefined): string | null {
  const p = (raw ?? "").trim() || SANDBOX_ROOT;
  if (!p.startsWith("/") || p.includes("\0") || p.length > 1024) return null;
  return path.posix.normalize(p);
}

export type SandboxEntry = { name: string; dir: boolean; size: number };

/** `find -printf '%y\t%s\t%f\n'` → entries, folders first. Pure. */
export function parseListing(stdout: string): SandboxEntry[] {
  return stdout
    .split("\n")
    .map((l) => l.split("\t"))
    .filter((parts) => parts.length >= 3 && parts[2])
    .map(([type, size, ...name]) => ({ name: name.join("\t"), dir: type === "d", size: Number(size) || 0 }))
    .sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name));
}
