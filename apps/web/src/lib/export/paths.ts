/**
 * Host paths → portable paths.
 *
 * `Project.workspacePath` and `Repository.localPath` are absolute paths on the
 * machine that wrote them. `/Users/dev/workspace/x` does not exist on a Linux
 * VM, and D-14 local sandboxes bind-mount `localPath` — a wrong value there
 * fails at provision time, which is the worst place to find out.
 *
 * So export rebases every path under a declared `pathRoot` and import rejoins
 * against the destination's own root. Paths outside the root are carried
 * absolute and reported, never silently rewritten.
 *
 * Everything here is POSIX-first: `path.posix` regardless of host, because the
 * document must read the same whether it was written on macOS or Linux. Windows
 * paths are normalised to forward slashes on the way in.
 */

import path from "path";

import type { PortablePath } from "./schema";

/** Forward slashes, no trailing separator (except a bare root). */
export function normalise(p: string): string {
  const slashed = p.replace(/\\/g, "/");
  const collapsed = path.posix.normalize(slashed);
  return collapsed.length > 1 ? collapsed.replace(/\/+$/, "") : collapsed;
}

/**
 * Longest common *directory* prefix of the given paths, or "" when they share
 * nothing (or there are none). Segment-wise rather than character-wise:
 * `/a/foo` and `/a/foobar` share `/a`, not `/a/foo`.
 */
export function commonRoot(paths: string[]): string {
  const usable = paths.filter(Boolean).map(normalise);
  if (usable.length === 0) return "";

  let prefix: string[] | null = null;
  for (const p of usable) {
    const segments = p.split("/");
    if (prefix === null) {
      prefix = segments;
      continue;
    }
    const next: string[] = [];
    for (let i = 0; i < Math.min(prefix.length, segments.length); i++) {
      if (prefix[i] !== segments[i]) break;
      next.push(prefix[i]);
    }
    prefix = next;
  }

  let joined = (prefix ?? []).join("/");
  // ["", "Users"] joins to "/Users"; [""] joins to "" but means "/".
  if (joined === "" && (prefix?.length ?? 0) > 0) joined = "/";

  // The root must be a *strict* ancestor of every path. When it equals one of
  // them the relative form of that path is "", which erases its own directory
  // name — and on import it resolves to the bare destination root. This is the
  // normal layout, not an edge case: a project whose repos live inside its
  // workspace makes the workspace itself the longest common prefix.
  if (usable.some((p) => p === joined)) {
    const parent = path.posix.dirname(joined);
    return parent === "." ? "" : parent;
  }

  return joined;
}

/** True when `child` is `root` itself or sits underneath it. */
export function isUnder(root: string, child: string): boolean {
  if (!root) return false;
  const r = normalise(root);
  const c = normalise(child);
  if (r === c) return true;
  return c.startsWith(r === "/" ? "/" : `${r}/`);
}

/**
 * Host path → portable. Under `pathRoot` it becomes relative; anything else
 * stays absolute so the import preview can flag it.
 */
export function relativise(
  absolute: string | null,
  pathRoot: string,
): PortablePath | null {
  if (!absolute) return null;
  const p = normalise(absolute);
  if (!isUnder(pathRoot, p)) return { root: "absolute", abs: p };
  const rel = path.posix.relative(normalise(pathRoot), p);
  return { root: "pathRoot", rel };
}

/**
 * Portable path → host path under the destination's root.
 *
 * A `pathRoot`-relative entry with no destination root is unresolvable — the
 * caller (the import dry run) reports it rather than inventing a location.
 */
export function resolvePortable(
  portable: PortablePath | null,
  destinationRoot: string,
): string | null {
  if (!portable) return null;
  if (portable.root === "absolute") return portable.abs;
  if (!destinationRoot) return null;
  // rel === "" means the root itself.
  return portable.rel
    ? path.posix.join(normalise(destinationRoot), portable.rel)
    : normalise(destinationRoot);
}
