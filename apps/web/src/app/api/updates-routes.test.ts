import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

// Env setup must stay above the route import — the handler resolves a saved
// GitHub credential through @nexux/db, whose client is built at module load.
import "./routes.test-setup";

import { POST as installUpdate } from "./updates/install/route";
import { GET as getUpdates, isNewer } from "./updates/route";

// --- semver compare ----------------------------------------------------------

test("isNewer compares numerically, not lexically", () => {
  assert.equal(isNewer("0.1.0", "0.2.0"), true);
  assert.equal(isNewer("0.2.0", "0.1.0"), false);
  assert.equal(isNewer("0.1.0", "0.1.0"), false);
  assert.equal(isNewer("0.9.0", "0.10.0"), true, "0.10 > 0.9");
  assert.equal(isNewer("1.0.0", "0.9.9"), false);
});

test("isNewer tolerates v prefixes and pre-release suffixes", () => {
  assert.equal(isNewer("v0.1.0", "v0.1.1"), true);
  assert.equal(isNewer("0.1.0", "v0.2.0-beta.1"), true);
  assert.equal(isNewer("0.2.0-beta.1", "0.2.0"), false, "suffix ignored");
});

test("an edge build compares as the release it is built past", () => {
  // `edge` images carry a `git describe`: 0.1.6-7-gabc1234 is seven commits
  // past v0.1.6. Before that they carried package.json's version, which only
  // changes on the release commit — so a host pulling edge every day reported
  // 0.1.4 forever and was told to update to a release it already contained.
  assert.equal(isNewer("0.1.6-7-gabc1234", "0.1.6"), false, "not behind itself");
  assert.equal(isNewer("0.1.6-7-gabc1234", "0.1.7"), true, "a real release is");
});

// --- GET ---------------------------------------------------------------------
// Order matters: the route keeps a module-level cache, so the empty-cache
// cases (no release, network down) must run before anything primes it.

/** The handler reads `?fresh=1` off the URL, so it needs a real Request. */
const req = (fresh = false) =>
  new Request(`http://localhost/api/updates${fresh ? "?fresh=1" : ""}`);

const realFetch = global.fetch;

afterEach(() => {
  global.fetch = realFetch;
});

/**
 * `releases/latest`, plus the tag-ref lookup the route makes to find which
 * commit the release points at. `tagSha` of null answers 404 for the ref, the
 * case where the commit check is unavailable and the version comparison has
 * to carry the decision on its own.
 */
function mockLatestRelease(
  response: () => Response,
  tagSha: string | null = null,
) {
  global.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (/git\/ref\/tags/.test(url)) {
      return tagSha
        ? new Response(
            JSON.stringify({ object: { type: "commit", sha: tagSha } }),
            { status: 200 },
          )
        : new Response("not found", { status: 404 });
    }
    assert.match(url, /releases\/latest/);
    return response();
  }) as typeof fetch;
}

test("GET answers 204 when no release is published yet", async () => {
  mockLatestRelease(() => new Response("not found", { status: 404 }));
  const res = await getUpdates(req());
  assert.equal(res.status, 204, "a fresh repo is not an error");
});

test("GET retries anonymously when the token is dead", async () => {
  process.env.GITHUB_TOKEN = "test-dead-token";
  const seen: Array<string | undefined> = [];
  global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    assert.match(String(input), /releases\/latest/);
    const auth = new Headers(init?.headers).get("authorization") ?? undefined;
    seen.push(auth);
    return auth
      ? new Response("bad credentials", { status: 401 })
      : new Response("not found", { status: 404 });
  }) as typeof fetch;
  try {
    const res = await getUpdates(req());
    assert.equal(res.status, 204, "dead token degrades to the anonymous path");
    assert.deepEqual(seen, ["Bearer test-dead-token", undefined]);
  } finally {
    delete process.env.GITHUB_TOKEN;
  }
});

test("GET answers 502 when GitHub errors and nothing is cached", async () => {
  global.fetch = (async () => {
    throw new Error("network down");
  }) as typeof fetch;
  const res = await getUpdates(req());
  assert.equal(res.status, 502);
});

test("GET reports a newer published release", async () => {
  mockLatestRelease(
    () =>
      new Response(
        JSON.stringify({
          tag_name: "v99.0.0",
          published_at: "2026-08-01T00:00:00Z",
          html_url: "https://github.com/ideascoldigital/nexus/releases/tag/v99.0.0",
        }),
        { status: 200 },
      ),
  );
  const res = await getUpdates(req());
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.latest, "99.0.0");
  assert.equal(body.tag, "v99.0.0");
  assert.equal(body.newer, true);
  assert.match(body.url, /releases\/tag\/v99\.0\.0/);
});

test("GET serves the cached release without a second GitHub call", async () => {
  let calls = 0;
  mockLatestRelease(() => {
    calls++;
    return new Response(
      JSON.stringify({ tag_name: "v99.0.0", published_at: null, html_url: "u" }),
      { status: 200 },
    );
  });
  await getUpdates(req());
  await getUpdates(req());
  assert.equal(calls, 0, "cache primed by the previous test must be reused");
});

test("?fresh=1 goes back to GitHub instead of serving the cache", async () => {
  // What a just-finished self-update asks for. The cached answer describes the
  // build that was replaced, and half an hour of it is exactly how long
  // "update available" outlived the update that installed it.
  let calls = 0;
  mockLatestRelease(() => {
    calls++;
    return new Response(
      JSON.stringify({ tag_name: "v98.0.0", published_at: null, html_url: "u" }),
      { status: 200 },
    );
  });
  const res = await getUpdates(req(true));
  assert.equal(calls, 1, "the primed cache must be bypassed");
  assert.equal((await res.json()).latest, "98.0.0");
});

test("POST /install answers 404 outside the native app", async () => {
  assert.notEqual(process.env.NEXUX_NATIVE, "1");
  const res = await installUpdate(jsonPost("http://127.0.0.1/api/updates/install"));
  assert.equal(res.status, 404, "self-install must never run on a host/dev install");
});

function jsonPost(url: string, headers: Record<string, string> = {}): Request {
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: "{}",
  });
}

test("POST /install refuses a request another website could send", async () => {
  // No auth on the sidecar (D-34): this is the only thing between any page in
  // the user's browser and "download and replace the app".
  process.env.NEXUX_NATIVE = "1";
  try {
    const simple = new Request("http://127.0.0.1/api/updates/install", {
      method: "POST",
      headers: { "content-type": "text/plain; x=application/json" },
      body: "{}",
    });
    assert.equal((await installUpdate(simple)).status, 403, "a no-preflight POST");
    const crossSite = jsonPost("http://127.0.0.1/api/updates/install", { "sec-fetch-site": "cross-site" });
    assert.equal((await installUpdate(crossSite)).status, 403);
    const rebound = jsonPost("http://evil.example/api/updates/install", { host: "evil.example:3030" });
    assert.equal((await installUpdate(rebound)).status, 403, "DNS rebinding");
  } finally {
    delete process.env.NEXUX_NATIVE;
  }
});

test("GET serves stale cache when GitHub goes down later", async () => {
  global.fetch = (async () => {
    throw new Error("network down");
  }) as typeof fetch;
  const res = await getUpdates(req());
  assert.equal(res.status, 200, "stale beats error once something is cached");
});

// --- the commit check --------------------------------------------------------
// `buildVersion()` memoizes per process ("resolved once per server process"),
// so these cannot steer `current` by setting NEXUX_VERSION mid-suite — they
// assert what the route *decides*, which is the part the commit changes.

test("a release that tags this very build is not an update", async () => {
  // The bug this exists for: PR #8 merged, the main build described itself
  // against the tags that existed at that instant (0.1.9-1-g3839a18), and
  // v0.2.0 was cut minutes later pointing at the same commit. Comparing
  // versions said "0.2.0 > 0.1.9" and offered a host an update to the code it
  // was already running — a byte-identical pull.
  const sha = "3839a18e762a4231937af6dc3b38a44bebe99397";
  process.env.NEXUX_GIT_SHA = sha;
  mockLatestRelease(
    () =>
      new Response(
        JSON.stringify({
          tag_name: "v99.0.0",
          published_at: "2026-09-20T03:33:45Z",
          html_url: "https://github.com/ideascoldigital/nexus/releases/tag/v99.0.0",
        }),
        { status: 200 },
      ),
    sha,
  );
  try {
    const body = await (await getUpdates(req(true))).json();
    assert.equal(body.sameCommit, true, "the release tags this commit");
    // v99.0.0 is newer than any version this build could report, so the
    // version comparison alone would certainly have offered the update.
    assert.equal(body.newer, false, "and there is nothing to update to");
  } finally {
    delete process.env.NEXUX_GIT_SHA;
  }
});

test("a release tagging a different commit is still an update", async () => {
  // The commit check must not swallow real updates.
  process.env.NEXUX_GIT_SHA = "3839a18e762a4231937af6dc3b38a44bebe99397";
  mockLatestRelease(
    () =>
      new Response(
        JSON.stringify({
          tag_name: "v99.0.0",
          published_at: "2026-10-01T00:00:00Z",
          html_url: "https://github.com/ideascoldigital/nexus/releases/tag/v99.0.0",
        }),
        { status: 200 },
      ),
    "c0ffee1234567890abcdef1234567890abcdef12",
  );
  try {
    const body = await (await getUpdates(req(true))).json();
    assert.equal(body.sameCommit, false);
    assert.equal(body.newer, true);
  } finally {
    delete process.env.NEXUX_GIT_SHA;
  }
});

test("an unresolvable tag falls back to comparing versions", async () => {
  // GitHub down, a rate limit, a private repo without a token: the commit
  // check is an extra signal, and losing it must leave the old behaviour
  // intact rather than silence the badge.
  process.env.NEXUX_GIT_SHA = "3839a18e762a4231937af6dc3b38a44bebe99397";
  mockLatestRelease(
    () =>
      new Response(
        JSON.stringify({
          tag_name: "v99.0.0",
          published_at: "2026-09-20T03:33:45Z",
          html_url: "https://github.com/ideascoldigital/nexus/releases/tag/v99.0.0",
        }),
        { status: 200 },
      ),
    null,
  );
  try {
    const body = await (await getUpdates(req(true))).json();
    assert.equal(body.sameCommit, false, "unknown is not 'same'");
    assert.equal(body.newer, true, "the version comparison still decides");
  } finally {
    delete process.env.NEXUX_GIT_SHA;
  }
});
