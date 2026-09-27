import { strict as assert } from "node:assert";
import { test } from "node:test";

import { checkGitHub, parseGitHubExpiry } from "./github";
import { shapeProblems } from "./shape";

const NOW = new Date("2026-09-27T12:00:00Z");
const TOKEN = "gho_" + "a".repeat(36);

/** A GitHub that answers /user with the given status, body and headers. */
function github(status: number, headers: Record<string, string> = {}, body: unknown = { login: "octocat" }) {
  const seen: Array<{ url: string; auth: string }> = [];
  const fetchFn = (async (url: string, init?: RequestInit) => {
    seen.push({ url, auth: (init?.headers as Record<string, string>).Authorization });
    return new Response(JSON.stringify(body), { status, headers });
  }) as typeof fetch;
  return { fetchFn, seen };
}

const line = (res: Awaited<ReturnType<typeof checkGitHub>>, label: string) =>
  res.checks.find((c) => c.label === label);

test("a classic token with repo and read:packages is ok, and names its account", async () => {
  const gh = github(200, { "x-oauth-scopes": "repo, read:packages, workflow" });
  const res = await checkGitHub(TOKEN, { fetch: gh.fetchFn, now: () => NOW });
  assert.equal(res.status, "ok");
  assert.equal(res.identity, "octocat");
  assert.deepEqual(res.scopes, ["repo", "read:packages", "workflow"]);
  assert.equal(line(res, "pull private images from ghcr.io")?.ok, true);
  // Only GitHub's own API, with the token as a bearer — never in the URL.
  assert.equal(gh.seen[0].url, "https://api.github.com/user");
  assert.equal(gh.seen[0].auth, `Bearer ${TOKEN}`);
});

test("missing read:packages is shown on its line without failing the token", async () => {
  const res = await checkGitHub(TOKEN, {
    fetch: github(200, { "x-oauth-scopes": "repo, workflow" }).fetchFn,
    now: () => NOW,
  });
  assert.equal(res.status, "ok");
  const pkg = line(res, "pull private images from ghcr.io");
  assert.equal(pkg?.ok, false);
  assert.match(pkg?.detail ?? "", /read:packages — only for a Nexus host whose image is private/);
});

test("a token without repo is a warning — every sandbox needs it", async () => {
  const res = await checkGitHub(TOKEN, {
    fetch: github(200, { "x-oauth-scopes": "read:org" }).fetchFn,
    now: () => NOW,
  });
  assert.equal(res.status, "warn");
  assert.equal(line(res, "clone and push private repos")?.ok, false);
});

test("a fine-grained token's scopes are unknown here, not missing", async () => {
  const res = await checkGitHub("github_pat_" + "x".repeat(82), {
    fetch: github(200, {}).fetchFn,
    now: () => NOW,
  });
  assert.equal(res.status, "ok");
  assert.equal(res.scopes, null);
  assert.equal(line(res, "clone and push private repos")?.ok, null);
});

test("expiry is read, and a token expiring soon warns", async () => {
  const res = await checkGitHub(TOKEN, {
    fetch: github(200, {
      "x-oauth-scopes": "repo",
      "github-authentication-token-expiration": "2026-10-03 00:00:00 UTC",
    }).fetchFn,
    now: () => NOW,
  });
  assert.equal(res.expiresAt, "2026-10-03T00:00:00.000Z");
  assert.equal(res.status, "warn");
  assert.match(line(res, "not about to expire")?.detail ?? "", /expires in 6 days/);
});

test("a rejected token fails with the reason, not a bare 401", async () => {
  const res = await checkGitHub(TOKEN, { fetch: github(401).fetchFn, now: () => NOW });
  assert.equal(res.status, "fail");
  assert.match(line(res, "GitHub accepts it")?.detail ?? "", /expired, revoked, or not a token/);
});

test("a pasted shell command is named before GitHub is asked", async () => {
  const gh = github(200);
  const res = await checkGitHub("gh auth token | pbcopy", { fetch: gh.fetchFn, now: () => NOW });
  assert.equal(res.status, "fail");
  assert.match(res.checks[0].detail ?? "", /shell command, not its output/);
  assert.equal(gh.seen.length, 0, "nothing was sent anywhere");
});

test("shape: whitespace and unknown prefixes warn, emptiness is fatal", () => {
  assert.equal(shapeProblems("github", "")[0].fatal, true);
  assert.match(shapeProblems("github", ` ${TOKEN}\n`)[0].message, /whitespace/);
  assert.match(shapeProblems("github", "abc123")[0].message, /doesn't start like a github token/);
  assert.deepEqual(shapeProblems("github", TOKEN), []);
});

test("expiry header parsing", () => {
  assert.equal(parseGitHubExpiry("2026-10-01 00:00:00 UTC"), "2026-10-01T00:00:00.000Z");
  assert.equal(parseGitHubExpiry(null), null);
  assert.equal(parseGitHubExpiry("soon"), null);
});
