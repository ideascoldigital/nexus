/**
 * The registry preflight. Spec: `specs/19-nexus-host-provisioning.md`.
 *
 * Covered here rather than through `POST /api/hosts` because the interesting
 * cases are the ones that *pass*: a route-level test of those would let
 * `createHost` reach terraform and provision a real instance.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import { after, afterEach, test } from "node:test";

// Above the import below: host-manager reaches @nexux/db, whose client is built
// at module load and needs a database to point at even though nothing here
// touches a row.
import { testDbDir } from "../app/api/routes.test-setup";
import { assertImagePullable, manifestPlatforms, ociArch } from "./host-manager";

after(() => {
  fs.rmSync(testDbDir, { recursive: true, force: true });
});

const CRED = {
  username: "octocat",
  password: "ghp_token",
  name: "gh-main",
};

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

/**
 * Stand in for a token registry, in the three steps a real pull takes: the
 * unauthenticated challenge that names the token endpoint, the token request,
 * then the manifest fetch that actually decides.
 *
 * `authenticated`/`anonymous` are **manifest** statuses, because that is what
 * this check turns on: the token endpoint here always issues a token, which is
 * exactly how GHCR behaves for any valid GitHub PAT even when the account
 * cannot read the package. `calls` records the sequence, so a test can assert
 * the anonymous retry happened rather than inferring it from the outcome.
 */
function stubRegistry(
  authenticated: number,
  anonymous: number,
  host = "ghcr.io",
  /** What a 200 manifest answers with — an index, when a test needs one. */
  manifestBody: unknown = null,
) {
  const calls: string[] = [];
  // Which credentials the token being carried was issued to.
  const issuedTo = new Map<string, "auth" | "anon">();
  let issued = 0;

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const headers = (init?.headers ?? {}) as Record<string, string>;

    if (url.startsWith(`https://${host}/token`)) {
      const kind = headers.Authorization?.startsWith("Basic ") ? "auth" : "anon";
      calls.push(`token:${kind}`);
      const token = `t${(issued += 1)}`;
      issuedTo.set(token, kind);
      return new Response(JSON.stringify({ token }), { status: 200 });
    }

    assert.ok(url.startsWith(`https://${host}/v2/`), `unexpected ${url}`);
    const bearer = headers.Authorization?.replace("Bearer ", "");
    if (!bearer) {
      calls.push("challenge");
      return new Response(null, {
        status: 401,
        headers: {
          "www-authenticate": `Bearer realm="https://${host}/token",service="${host}"`,
        },
      });
    }
    const kind = issuedTo.get(bearer) ?? "anon";
    calls.push(`manifest:${kind}`);
    const status = kind === "auth" ? authenticated : anonymous;
    return new Response(status === 200 && manifestBody ? JSON.stringify(manifestBody) : null, {
      status,
    });
  }) as typeof fetch;
  return calls;
}

test("a pullable image passes with the credential intact", async () => {
  stubRegistry(200, 401);
  const out = await assertImagePullable("ghcr.io/o/r:edge", CRED, true);
  assert.deepEqual(out.registry, CRED);
});

test("a public image is not blocked by a stale token nobody chose", async () => {
  // A registry rejects an expired credential even for an image anyone could pull
  // anonymously. That token was never chosen — it is merely the one saved — so
  // failing here would block an image that works. Pull as nobody instead.
  const calls = stubRegistry(401, 200);
  const out = await assertImagePullable("ghcr.io/o/public:edge", CRED, false);
  assert.equal(out.registry, null);
  assert.deepEqual(calls, [
    "challenge",
    "token:auth",
    "manifest:auth",
    "token:anon",
    "manifest:anon",
  ]);
});

test("a token the registry issues but will not honour is caught", async () => {
  // The failure this check exists for, reproduced from a real host: GHCR issues
  // a token to any valid GitHub PAT, so a token missing `read:packages` passes
  // the token endpoint, `docker login` reports success, and the pull is denied
  // twenty minutes later. Only the manifest request tells them apart.
  stubRegistry(403, 403);
  await assert.rejects(
    () => assertImagePullable("ghcr.io/o/private:edge", CRED, true),
    /read:packages scope and access to the package/,
  );
});

test("a tag the registry does not have is reported as a tag problem", async () => {
  // 404 on an authenticated request is a different mistake from a denied one,
  // and no change of token fixes it.
  stubRegistry(404, 404);
  await assert.rejects(
    () => assertImagePullable("ghcr.io/o/r:nope", CRED, true),
    /has no tag “nope”/,
  );
});

test("an image with no tag is checked as :latest", async () => {
  // What docker would pull; probing a tag the reference does not name would
  // report a problem the real pull never hits.
  stubRegistry(404, 404);
  await assert.rejects(
    () => assertImagePullable("ghcr.io/o/r", CRED, true),
    /has no tag “latest”/,
  );
});

test("a missing tag on a public image blames the tag, not the saved token", async () => {
  // Found against a real public package with no `latest`: the token is refused,
  // anonymous answers 404, and reporting that as a credential problem sends the
  // user to fix a token that was never the issue.
  stubRegistry(403, 404);
  await assert.rejects(
    () => assertImagePullable("ghcr.io/o/public:edge", CRED, false),
    /has no tag “edge”\. Check the tag/,
  );
});

test("a chosen credential that cannot pull is an error, public image or not", async () => {
  // The mirror of the case above: quietly ignoring a credential the user picked
  // would hide that it does not work.
  stubRegistry(403, 200);
  await assert.rejects(
    () => assertImagePullable("ghcr.io/o/public:edge", CRED, true),
    /gh-main/,
  );
});

test("a private image with no credential says what to do about it", async () => {
  stubRegistry(401, 401);
  await assert.rejects(
    () => assertImagePullable("ghcr.io/o/r:edge", null, false),
    /no saved token logs in to ghcr.io/,
  );
});

test("a non-GitHub registry is probed the same way, and named in the error", async () => {
  // The token endpoint comes from the registry's own challenge, so GitLab and a
  // self-hosted registry need no special case — only the message differs.
  stubRegistry(403, 403, "registry.gitlab.com");
  await assert.rejects(
    () =>
      assertImagePullable(
        "registry.gitlab.com/group/app:edge",
        { ...CRED, name: "gl-main" },
        true,
      ),
    /registry.gitlab.com with “gl-main”.*read_registry/s,
  );
});

test("a registry that does not use token auth is left alone", async () => {
  // No challenge means nothing to probe; the pull is the host's problem.
  globalThis.fetch = (async () =>
    new Response(null, { status: 200 })) as typeof fetch;
  const out = await assertImagePullable("registry.internal/app:1", CRED, true);
  assert.deepEqual(out.registry, CRED);
});

test("a registry that cannot be reached is not treated as a refusal", async () => {
  // Unreachable from this laptop says nothing about the host, and refusing on a
  // network hiccup would be worse than letting the pull fail on the instance.
  globalThis.fetch = (() => Promise.reject(new Error("offline"))) as never;
  const out = await assertImagePullable("ghcr.io/o/r:edge", CRED, true);
  assert.deepEqual(out.registry, CRED);
});

test("a non-GHCR image is not probed at all", async () => {
  // Only GHCR authenticates with a saved GitHub token; probing Docker Hub with
  // one would be meaningless, and a request per creation is not free.
  globalThis.fetch = (() => {
    throw new Error("should not be called");
  }) as never;
  const out = await assertImagePullable("docker.io/library/nexus:1", null, false);
  assert.equal(out.registry, null);
});

// --- platforms (spec 27) ------------------------------------------------------

const INDEX = {
  manifests: [
    { platform: { os: "linux", architecture: "amd64" } },
    { platform: { os: "linux", architecture: "arm64", variant: "v8" } },
    // Build attestations ride in the index too; they are not a platform.
    { platform: { os: "unknown", architecture: "unknown" } },
  ],
};

test("the platforms an image publishes come back with the pull check", async () => {
  stubRegistry(200, 401, "ghcr.io", INDEX);
  const out = await assertImagePullable("ghcr.io/o/r:edge", CRED, true);
  assert.deepEqual(out.platforms, ["linux/amd64", "linux/arm64/v8"]);
});

test("a single-platform manifest says nothing about platforms, rather than none", () => {
  assert.equal(manifestPlatforms({ config: {}, layers: [] }), null);
  assert.equal(manifestPlatforms(null), null);
  assert.deepEqual(manifestPlatforms(INDEX), ["linux/amd64", "linux/arm64/v8"]);
});

test("docker info's architecture maps to the names indexes use", () => {
  assert.equal(ociArch("x86_64"), "amd64");
  assert.equal(ociArch("aarch64"), "arm64");
  assert.equal(ociArch("armv7l"), "arm");
});
