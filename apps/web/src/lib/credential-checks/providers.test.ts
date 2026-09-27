import { strict as assert } from "node:assert";
import { test } from "node:test";

import { checkBitbucket } from "./bitbucket";
import { checkClaude } from "./claude";
import { checkGitLab } from "./gitlab";
import { checkCredential } from "./index";
import { LLM_CHECKABLE, checkLlmKey } from "./llm";
import { CHECKABLE_PROVIDERS } from "./types";

const NOW = new Date("2026-09-27T12:00:00Z");

/** A provider answering by URL; records every request. */
function stub(routes: Record<string, { status: number; body?: unknown; headers?: Record<string, string> }>) {
  const seen: Array<{ url: string; headers: Record<string, string> }> = [];
  const fetchFn = (async (url: string, init?: RequestInit) => {
    seen.push({ url, headers: init?.headers as Record<string, string> });
    const route = Object.entries(routes).find(([k]) => url.startsWith(k))?.[1];
    if (!route) throw new Error(`unexpected ${url}`);
    return new Response(route.body === undefined ? "" : JSON.stringify(route.body), {
      status: route.status,
      headers: route.headers,
    });
  }) as typeof fetch;
  return { fetchFn, seen };
}

const line = (r: { checks: Array<{ label: string; ok: boolean | null; detail?: string }> }, label: string) =>
  r.checks.find((c) => c.label === label);

// --- GitLab -------------------------------------------------------------------

test("gitlab: scopes and expiry from the token itself, on the self-hosted host", async () => {
  const s = stub({
    "https://gitlab.acme.dev/api/v4/user": { status: 200, body: { username: "jairo" } },
    "https://gitlab.acme.dev/api/v4/personal_access_tokens/self": {
      status: 200,
      body: { scopes: ["read_repository", "write_repository"], expires_at: "2026-12-31", active: true },
    },
  });
  const r = await checkGitLab("glpat-" + "x".repeat(20), { registryHost: "registry.gitlab.acme.dev:5050" }, { fetch: s.fetchFn, now: () => NOW });
  assert.equal(r.status, "ok");
  assert.equal(r.identity, "jairo @ gitlab.acme.dev");
  assert.equal(r.expiresAt, "2026-12-31T00:00:00.000Z");
  assert.equal(line(r, "push branches")?.ok, true);
  assert.equal(line(r, "open merge requests")?.ok, false);
  // The token is a header, never part of the URL.
  assert.ok(s.seen.every((x) => !x.url.includes("glpat-")));
  assert.equal(s.seen[0].headers["PRIVATE-TOKEN"], "glpat-" + "x".repeat(20));
});

test("gitlab: read-only token warns — sandboxes push", async () => {
  const s = stub({
    "https://gitlab.com/api/v4/user": { status: 200, body: { username: "jairo" } },
    "https://gitlab.com/api/v4/personal_access_tokens/self": { status: 200, body: { scopes: ["read_repository"], active: true } },
  });
  const r = await checkGitLab("glpat-abc", {}, { fetch: s.fetchFn, now: () => NOW });
  assert.equal(r.status, "warn");
  assert.equal(line(r, "push branches")?.ok, false);
});

test("gitlab: an instance that cannot describe the token leaves scopes unknown", async () => {
  const s = stub({
    "https://gitlab.com/api/v4/user": { status: 200, body: { username: "jairo" } },
    "https://gitlab.com/api/v4/personal_access_tokens/self": { status: 404 },
  });
  const r = await checkGitLab("glpat-abc", {}, { fetch: s.fetchFn, now: () => NOW });
  assert.equal(r.scopes, null);
  assert.equal(line(r, "clone private repos")?.ok, null);
});

test("gitlab: a rejected token fails", async () => {
  const r = await checkGitLab("glpat-abc", {}, { fetch: stub({ "https://gitlab.com/api/v4/user": { status: 401 } }).fetchFn, now: () => NOW });
  assert.equal(r.status, "fail");
});

// --- Bitbucket ------------------------------------------------------------------

test("bitbucket: a user token names its account; a repository token is valid but not account-wide", async () => {
  const user = await checkBitbucket("tok", {
    fetch: stub({ "https://api.bitbucket.org/2.0/user": { status: 200, body: { username: "jairo" } } }).fetchFn,
    now: () => NOW,
  });
  assert.equal(user.identity, "jairo");
  const repoToken = await checkBitbucket("tok", {
    fetch: stub({ "https://api.bitbucket.org/2.0/user": { status: 403 } }).fetchFn,
    now: () => NOW,
  });
  assert.equal(repoToken.status, "ok");
  assert.equal(line(repoToken, "account-wide access")?.ok, null);
});

// --- Claude Code ------------------------------------------------------------------

test("claude: accepted, rejected, or honestly unverifiable", async () => {
  const token = "sk-ant-oat01-" + "z".repeat(40);
  const api = (status: number) => stub({ "https://api.anthropic.com/v1/models": { status } }).fetchFn;
  assert.equal((await checkClaude(token, { fetch: api(200), now: () => NOW })).status, "ok");
  const rejected = await checkClaude(token, { fetch: api(401), now: () => NOW });
  assert.equal(rejected.status, "fail");
  assert.match(rejected.checks.at(-1)?.detail ?? "", /claude setup-token/);
  const unknown = await checkClaude(token, { fetch: api(400), now: () => NOW });
  assert.equal(unknown.status, "ok");
  assert.equal(line(unknown, "Anthropic accepts it")?.ok, null);
});

// --- LLM keys ---------------------------------------------------------------------

test("llm: each provider is asked with its own header, never a key in the URL", async () => {
  const s = stub({
    "https://generativelanguage.googleapis.com": { status: 200, body: { models: [] } },
  });
  const r = await checkLlmKey("google", "AIza" + "k".repeat(35), { fetch: s.fetchFn, now: () => NOW });
  assert.equal(r?.status, "ok");
  assert.ok(!s.seen[0].url.includes("AIza"));
  assert.equal(s.seen[0].headers["x-goog-api-key"], "AIza" + "k".repeat(35));
});

test("llm: google's bad key is a 400, reported as a rejection", async () => {
  const r = await checkLlmKey("google", "AIzaBAD", {
    fetch: stub({ "https://generativelanguage.googleapis.com": { status: 400 } }).fetchFn,
    now: () => NOW,
  });
  assert.equal(r?.status, "fail");
});

test("llm: openrouter reports credit, and warns when it runs out", async () => {
  const r = await checkLlmKey("openrouter", "sk-or-v1-abc", {
    fetch: stub({
      "https://openrouter.ai/api/v1/key": { status: 200, body: { data: { label: "nexux", limit: 10, usage: 9.5, limit_remaining: 0.5 } } },
    }).fetchFn,
    now: () => NOW,
  });
  assert.equal(r?.identity, "nexux");
  assert.equal(r?.status, "warn");
  assert.match(line(r!, "has credit left")?.detail ?? "", /\$0\.50 of \$10\.00/);
});

test("llm: an unknown provider has no check", async () => {
  assert.equal(await checkLlmKey("civo", "x"), null);
});

// --- wiring -----------------------------------------------------------------------

test("every provider the UI offers Test for has a check behind it", async () => {
  for (const p of LLM_CHECKABLE) assert.ok(CHECKABLE_PROVIDERS.has(p), p);
  const nope = (async () => {
    throw new Error("offline");
  }) as unknown as typeof fetch;
  for (const provider of CHECKABLE_PROVIDERS) {
    const r = await checkCredential({ provider, data: { token: "x", apiKey: "x" } }, { fetch: nope, now: () => NOW });
    assert.ok(r, `${provider} is offered but has no check`);
  }
  assert.equal(await checkCredential({ provider: "civo", data: { token: "x" } }), null);
});
