/**
 * Which version of Nexus this process is.
 *
 * Three sources, in falling order of trust:
 *
 * 1. `NEXUX_VERSION`, baked at image build time. A tagged release carries the
 *    release; an `edge` image carries a `git describe` (release-image.yml).
 * 2. `git describe` against the working tree — the `pnpm dev` case, where
 *    nothing was baked because nothing was built.
 * 3. `package.json`, and only then. It is a poor source on its own: it changes
 *    only when someone remembers to bump it on a release commit, and nobody
 *    did for v0.1.5 or v0.1.6 — both tags still say 0.1.4. A dev checkout that
 *    trusted it reported 0.1.4 three releases later and the statusbar offered
 *    an update to a release the tree already contained.
 *
 * Resolved once per server process: the answer cannot change without a restart
 * (a rebuilt image is a new container; a dev checkout is a new `next dev`).
 */

import { execFile } from "child_process";
import { promisify } from "util";

import pkg from "../../package.json";

const execFileP = promisify(execFile);

/** `0.1.6-3-g586da57` — the release, how far past it, and the commit. */
async function describe(): Promise<string | null> {
  return execFileP("git", ["describe", "--tags", "--match", "v[0-9]*"])
    .then(({ stdout }) => stdout.trim().replace(/^v/, "") || null)
    // No tags (a fresh fork), no git (an image without .git), no git binary.
    .catch(() => null);
}

/**
 * The resolution itself, with its two lookups injected.
 *
 * Separate from the memoized `buildVersion` so a test can exercise the order
 * without reaching through a module-level cache that, by design, answers once
 * per process and never again.
 */
export async function resolveVersion(
  baked: string | undefined,
  describeTree: () => Promise<string | null>,
  packageVersion: string,
): Promise<string> {
  const fromEnv = baked?.trim();
  if (fromEnv) return fromEnv.replace(/^v/, "");
  return (await describeTree()) ?? packageVersion;
}

let versionPromise: Promise<string> | undefined;

export function buildVersion(): Promise<string> {
  versionPromise ??= resolveVersion(
    process.env.NEXUX_VERSION,
    describe,
    pkg.version,
  );
  return versionPromise;
}

/**
 * The release a version belongs to. Identity for a plain `0.1.6`; for a
 * describe of a build past that release, the release it counts from — the only
 * part of the string that names a tag GitHub can show.
 */
export function releaseOf(version: string): string {
  return version.replace(/^v/, "").split(/[-+]/)[0];
}
