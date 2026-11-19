// Spec 25, piece 1 — the runnable units inside a repository.
//
// The assumption this exists to kill: **one repository does not mean one
// node.** A project may arrive as one repo, several repos, a single monorepo
// holding a front end and an API, or a mix — and the stack should describe the
// same graph for all of them, because it cares about what *boots*, not about
// how many gits the code came in.
//
// So discovery is two passes. This module does the first: read the workspace
// declaration and expand it into concrete directories. `detectRepo` then does
// the second on each one, unchanged — it already takes an arbitrary path, so a
// unit at `apps/api` is scanned by the same function that scans a repo root.

import path from "path";
import { LocalFsStorage, expandHome } from "@nexux/storage";

const storage = new LocalFsStorage("/");

export type RunnableUnit = {
  /** Display name: the repo name, or `<repo>/<workdir>` inside a workspace. */
  name: string;
  /** Absolute path on this host. */
  localPath: string;
  /** Path relative to the repo root; empty string for the root itself. */
  workdir: string;
  /** True for the repository root, which is also where a workspace installs. */
  isRoot: boolean;
};

/**
 * Where a workspace declares its members.
 *
 * JS-only today. A Go (`go.work`), Cargo or multi-`pyproject.toml` monorepo
 * falls through to one unit at the root, which is correct and merely coarse —
 * this table is the extension point, not a special case elsewhere.
 */
const WORKSPACE_FILES = ["pnpm-workspace.yaml", "pnpm-workspace.yml"] as const;

/** How deep a glob may be expanded, so `**` cannot walk a whole disk. */
const MAX_GLOB_DEPTH = 3;

/** Hard cap on units, so a pathological workspace cannot fill a canvas. */
const MAX_UNITS = 24;

async function readTextSafe(file: string): Promise<string | null> {
  try {
    return await storage.readText(file);
  } catch {
    return null;
  }
}

async function readJsonSafe(file: string): Promise<Record<string, unknown> | null> {
  const raw = await readTextSafe(file);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * The glob patterns a repo's workspace declares, or [] when it declares none.
 *
 * `pnpm-workspace.yaml` is parsed by hand rather than with a YAML library: the
 * file is a single `packages:` list of strings in every real case, and the
 * alternative is pulling a parser into a code path that must not fail loudly
 * on a file it does not understand.
 */
export async function workspacePatterns(root: string): Promise<string[]> {
  for (const file of WORKSPACE_FILES) {
    const raw = await readTextSafe(path.join(root, file));
    if (!raw) continue;
    const patterns: string[] = [];
    let inPackages = false;
    for (const line of raw.split("\n")) {
      if (/^packages:/.test(line.trim())) {
        inPackages = true;
        continue;
      }
      if (inPackages) {
        const item = /^\s*-\s*['"]?([^'"#]+?)['"]?\s*(#.*)?$/.exec(line);
        if (item) {
          patterns.push(item[1].trim());
          continue;
        }
        // A non-list, non-blank line ends the block.
        if (line.trim() && !line.startsWith(" ") && !line.startsWith("\t")) break;
      }
    }
    if (patterns.length) return patterns;
  }

  const pkg = await readJsonSafe(path.join(root, "package.json"));
  const ws = pkg?.workspaces;
  if (Array.isArray(ws)) {
    return ws.filter((p): p is string => typeof p === "string");
  }
  // npm/yarn also allow { packages: [...] }.
  if (ws && typeof ws === "object" && Array.isArray((ws as { packages?: unknown }).packages)) {
    return ((ws as { packages: unknown[] }).packages).filter(
      (p): p is string => typeof p === "string",
    );
  }
  return [];
}

/**
 * Expands one workspace glob into the directories that exist.
 *
 * Only the two forms that appear in practice — `apps/*` and a literal path —
 * plus a bounded `**`. A full glob implementation would be a dependency and a
 * surface for a pattern that walks somewhere it should not; anything this does
 * not understand is skipped, which costs a node the user can add by hand.
 */
async function expandPattern(root: string, pattern: string): Promise<string[]> {
  const clean = pattern.replace(/^\.\//, "").replace(/\/+$/, "");
  if (!clean || clean.startsWith("!") || clean.startsWith("/") || clean.includes("..")) {
    return [];
  }

  const segments = clean.split("/");
  if (segments.length > MAX_GLOB_DEPTH) return [];

  let candidates = [""];
  for (const segment of segments) {
    const next: string[] = [];
    for (const base of candidates) {
      const dir = path.join(root, base);
      if (segment === "*" || segment === "**") {
        // listDetailed, so a stray file matching the glob is not offered as a
        // directory to scan.
        let entries: Awaited<ReturnType<typeof storage.listDetailed>>;
        try {
          entries = await storage.listDetailed(dir);
        } catch {
          continue;
        }
        for (const entry of entries) {
          if (!entry.isDirectory) continue;
          if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
          const rel = base ? `${base}/${entry.name}` : entry.name;
          if (await storage.exists(path.join(root, rel, "package.json"))) {
            next.push(rel);
          } else if (segment === "**") {
            next.push(rel);
          }
        }
      } else {
        const rel = base ? `${base}/${segment}` : segment;
        if (await storage.exists(path.join(root, rel))) next.push(rel);
      }
    }
    candidates = next;
    if (!candidates.length) break;
  }

  return candidates.filter(Boolean);
}

/**
 * The runnable units of one repository.
 *
 * A repo with no workspace declaration yields exactly one unit — its root —
 * which is the shape everything already assumed, so a single-app repo behaves
 * identically to before.
 *
 * The root is always included, even in a workspace: a monorepo's top-level
 * `pnpm install` is what makes every member installable, and its Makefile may
 * hold the `docker compose up` for the whole thing. Whether it also *runs*
 * something is `seed`'s decision, from its detection.
 */
export async function findRunnableUnits(
  repoName: string,
  localPath: string,
): Promise<RunnableUnit[]> {
  const root = expandHome(localPath);
  const rootUnit: RunnableUnit = {
    name: repoName,
    localPath: root,
    workdir: "",
    isRoot: true,
  };

  const patterns = await workspacePatterns(root);
  if (!patterns.length) return [rootUnit];

  const seen = new Set<string>();
  const units: RunnableUnit[] = [rootUnit];
  for (const pattern of patterns) {
    for (const rel of await expandPattern(root, pattern)) {
      if (seen.has(rel) || units.length >= MAX_UNITS) continue;
      seen.add(rel);
      units.push({
        // `<repo>/<workdir>` rather than the bare directory name: two
        // workspaces can both hold an `api`, and a canvas with two nodes
        // called "api" is one nobody can read.
        name: `${repoName}/${rel}`,
        localPath: path.join(root, rel),
        workdir: rel,
        isRoot: false,
      });
    }
  }
  return units;
}
