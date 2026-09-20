/**
 * Which build of Nexus is serving this request.
 *
 * Exists for the update flows in Settings → Nexus hosts and the statusbar:
 * "update" is meaningless if nothing says what is running now, and "did the
 * update do anything" needs a before/after to compare. The identity is baked
 * in at build time — the Docker image sets NEXUX_GIT_SHA / NEXUX_VERSION as
 * env (Dockerfile args from CI) plus /app/.built-at, the native sidecar ships
 * a build-info.json that start.js loads into the same env vars — and a dev
 * checkout falls back to `git describe` plus `git rev-parse`. See
 * `@/lib/build-version` for why package.json is the last resort, not the
 * first.
 */

import fs from "fs/promises";

import { NextResponse } from "next/server";

import { buildGitSha } from "@/lib/build-sha";
import { buildVersion, releaseOf } from "@/lib/build-version";
import { REPO_URL } from "@/lib/repo";

export const dynamic = "force-dynamic";

export type AppVersion = {
  /** Release version — the image tag from CI, else the package version. */
  version: string;
  /** Commit this build came from; null when it cannot be known. */
  gitSha: string | null;
  /** When the build was made; null on a dev checkout. */
  builtAt: string | null;
  /** GitHub page for the commit; null when gitSha is null. */
  commitUrl: string | null;
  /** GitHub release page for this version. */
  releaseUrl: string;
  /** True inside the native app (sidecar) — set by its start.js. */
  native: boolean;
};

export async function GET() {
  // Written by the Dockerfile on every image build, CI or local — the one
  // marker that distinguishes two builds even when neither arg was passed.
  const builtAt =
    process.env.NEXUX_BUILT_AT ||
    (await fs
      .readFile("/app/.built-at", "utf8")
      .then((s) => s.trim() || null)
      .catch(() => null));

  const gitSha = await buildGitSha();
  const version = await buildVersion();

  const body: AppVersion = {
    version,
    gitSha,
    builtAt,
    commitUrl: gitSha ? `${REPO_URL}/commit/${gitSha}` : null,
    // An `edge` build's version is a `git describe` — 0.1.6-7-gabc1234, seven
    // commits past the release. Only the release part names a real tag; the
    // whole string linked to a 404 on GitHub.
    releaseUrl: `${REPO_URL}/releases/tag/v${releaseOf(version)}`,
    native: process.env.NEXUX_NATIVE === "1",
  };
  return NextResponse.json(body);
}
