/**
 * Is a newer Nexus release published on GitHub?
 *
 * Statusbar polls this. The server does the GitHub call (one shared cache
 * instead of one call per browser tab, and no client-side rate-limit worries)
 * and compares against its own baked-in version, so the answer is always about
 * the build actually running. Latest-release only — drafts and prereleases
 * never show up, which matches the release flow: release-native.yml attaches
 * bundles to a draft, and publishing the draft is the "ship it" act.
 */

import { NextResponse } from "next/server";

import { buildVersion } from "@/lib/build-version";
import { githubToken } from "@/lib/github-token";
import { REPO } from "@/lib/repo";

export const dynamic = "force-dynamic";

export type UpdateStatus = {
  /** Version this install is running. */
  current: string;
  /** Newest published release version. */
  latest: string;
  /** Tag of that release, e.g. "v0.2.0". */
  tag: string;
  /** True when latest is strictly newer than current. */
  newer: boolean;
  publishedAt: string | null;
  /** Release page — where the click on the badge lands. */
  url: string;
};

/** Numeric semver compare, tolerant of a leading v: is `b` newer than `a`? */
export function isNewer(a: string, b: string): boolean {
  const parse = (v: string) =>
    v
      .replace(/^v/, "")
      .split(/[-+]/)[0]
      .split(".")
      .map((n) => parseInt(n, 10) || 0);
  const [x, y] = [parse(a), parse(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (y[i] ?? 0) - (x[i] ?? 0);
    if (d !== 0) return d > 0;
  }
  return false;
}

type CachedRelease = {
  tag: string;
  publishedAt: string | null;
  url: string;
  fetchedAt: number;
};

const CACHE_TTL_MS = 30 * 60 * 1000;
let cache: CachedRelease | null = null;

/** Thrown when the repo simply has no published release yet — not an error. */
class NoReleaseYet extends Error {}

async function fetchLatest(token: string | null): Promise<Response> {
  return fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
    headers: {
      Accept: "application/vnd.github+json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    cache: "no-store",
  });
}

async function latestRelease(fresh = false): Promise<CachedRelease> {
  if (!fresh && cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS)
    return cache;
  const token = await githubToken();
  let res = await fetchLatest(token);
  // A dead saved token (revoked, expired) answers 401/403. The update check
  // must not die with it — retry anonymously, which works once the repo is
  // public and otherwise lands on the 404 → "nothing to report" path.
  if (token && (res.status === 401 || res.status === 403)) {
    res = await fetchLatest(null);
  }
  if (!res.ok) {
    // 404 = repo has no published release yet (drafts don't count); anything
    // else is GitHub or the network. A stale cache beats either answer.
    if (cache) return cache;
    if (res.status === 404) throw new NoReleaseYet();
    throw new Error(`GitHub releases/latest answered ${res.status}`);
  }
  const release = (await res.json()) as {
    tag_name: string;
    published_at: string | null;
    html_url: string;
  };
  cache = {
    tag: release.tag_name,
    publishedAt: release.published_at,
    url: release.html_url,
    fetchedAt: Date.now(),
  };
  return cache;
}

export async function GET(req: Request) {
  const current = await buildVersion();
  // `?fresh=1` comes from a self-update that just finished: the cached answer
  // is about the build that was replaced, and half an hour of it is exactly
  // how long "update available" outlived the update.
  const fresh = new URL(req.url).searchParams.get("fresh") === "1";
  let release: CachedRelease;
  try {
    release = await latestRelease(fresh);
  } catch (e) {
    // 204, not an error status: "nothing published yet" is the normal state
    // of a fresh install and must not spam the browser console.
    if (e instanceof NoReleaseYet) return new NextResponse(null, { status: 204 });
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 502 },
    );
  }
  const latest = release.tag.replace(/^v/, "");
  const body: UpdateStatus = {
    current,
    latest,
    tag: release.tag,
    newer: isNewer(current, latest),
    publishedAt: release.publishedAt,
    url: release.url,
  };
  return NextResponse.json(body);
}
