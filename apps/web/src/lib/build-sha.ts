/**
 * The commit this process was built from.
 *
 * Split out of `/api/version` because the update check needs the same answer:
 * a version string cannot always decide whether a release is newer than the
 * running build, but a commit can — see `/api/updates`.
 *
 * Resolved once per server process. A CI build has NEXUX_GIT_SHA baked in by
 * the Dockerfile; only `pnpm dev` reaches the git call, and a checkout without
 * git (or without a .git) answers null rather than failing.
 */

import { execFile } from "child_process";
import { promisify } from "util";

const execFileP = promisify(execFile);

let devShaPromise: Promise<string | null> | undefined;

function devGitSha(): Promise<string | null> {
  devShaPromise ??= execFileP("git", ["rev-parse", "HEAD"])
    .then(({ stdout }) => stdout.trim() || null)
    .catch(() => null);
  return devShaPromise;
}

export async function buildGitSha(): Promise<string | null> {
  return process.env.NEXUX_GIT_SHA || (await devGitSha());
}

/**
 * Do two commit ids name the same commit?
 *
 * Length-tolerant on purpose: what is baked into an image is a full 40-char
 * sha, what a `git describe` carries is the abbreviated seven, and a tag's ref
 * comes back full from the API. Comparing the shorter length means an
 * abbreviated sha still matches the full one it abbreviates.
 */
export function sameCommit(
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  if (!a || !b) return false;
  const x = a.trim().toLowerCase();
  const y = b.trim().toLowerCase();
  // Seven is git's default abbreviation and the shortest thing worth trusting;
  // below that a prefix match would start colliding across a real repo.
  const n = Math.min(x.length, y.length);
  if (n < 7) return false;
  return x.slice(0, n) === y.slice(0, n);
}
