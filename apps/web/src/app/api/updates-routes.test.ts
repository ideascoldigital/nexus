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

function mockLatestRelease(response: () => Response) {
  global.fetch = (async (input: RequestInfo | URL) => {
    assert.match(String(input), /releases\/latest/);
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
  const res = await installUpdate();
  assert.equal(res.status, 404, "self-install must never run on a host/dev install");
});

test("GET serves stale cache when GitHub goes down later", async () => {
  global.fetch = (async () => {
    throw new Error("network down");
  }) as typeof fetch;
  const res = await getUpdates(req());
  assert.equal(res.status, 200, "stale beats error once something is cached");
});
