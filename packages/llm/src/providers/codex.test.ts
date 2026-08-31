import { strict as assert } from "node:assert";
import { afterEach, beforeEach, test } from "node:test";

import {
  createCodexCompletion,
  fetchCodexModels,
  fetchCodexUserInfo,
  testCodexApiKey,
} from "./codex";

const BASE = "http://codex.test";

interface RecordedCall {
  url: string;
  init?: RequestInit;
}

let calls: RecordedCall[];
let originalFetch: typeof fetch;

function mockFetch(handler: (url: string) => Response | Promise<Response>) {
  globalThis.fetch = (async (input: any, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    return handler(url);
  }) as typeof fetch;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  calls = [];
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("fetchCodexUserInfo hits /user with bearer auth", async () => {
  mockFetch(() => json({ id: "u1", email: "a@b.c" }));
  const user = await fetchCodexUserInfo("key123", BASE);
  assert.deepEqual(user, { id: "u1", email: "a@b.c" });
  assert.equal(calls[0].url, `${BASE}/user`);
  const headers = calls[0].init?.headers as Record<string, string>;
  assert.equal(headers["Authorization"], "Bearer key123");
});

test("fetchCodexUserInfo throws with status and body on error", async () => {
  mockFetch(() => new Response("nope", { status: 401 }));
  await assert.rejects(
    fetchCodexUserInfo("bad", BASE),
    /Failed to fetch user info: 401 - nope/,
  );
});

test("fetchCodexModels unwraps { models: [...] }", async () => {
  mockFetch(() => json({ models: [{ id: "m1", name: "One" }] }));
  const models = await fetchCodexModels("k", BASE);
  assert.deepEqual(models, [{ id: "m1", name: "One" }]);
  assert.equal(calls[0].url, `${BASE}/models`);
});

test("fetchCodexModels accepts a bare array", async () => {
  mockFetch(() => json([{ id: "m2", name: "Two" }]));
  const models = await fetchCodexModels("k", BASE);
  assert.deepEqual(models, [{ id: "m2", name: "Two" }]);
});

test("testCodexApiKey returns true on success, false on failure", async () => {
  mockFetch(() => json({ id: "u1", email: "a@b.c" }));
  assert.equal(await testCodexApiKey("good", BASE), true);

  mockFetch(() => new Response("denied", { status: 403 }));
  assert.equal(await testCodexApiKey("bad", BASE), false);
});

test("createCodexCompletion posts prompt with defaults", async () => {
  mockFetch(() => json({ choices: [] }));
  await createCodexCompletion("k", "say hi", { baseUrl: BASE });
  assert.equal(calls[0].url, `${BASE}/completions`);
  assert.equal(calls[0].init?.method, "POST");
  const body = JSON.parse(String(calls[0].init?.body));
  assert.deepEqual(body, {
    model: "codex-default",
    prompt: "say hi",
    max_tokens: 100,
    temperature: 0.7,
  });
});

test("createCodexCompletion honors options and surfaces errors", async () => {
  mockFetch(() => json({ ok: true }));
  await createCodexCompletion("k", "p", {
    baseUrl: BASE,
    model: "codex-pro",
    maxTokens: 5,
    temperature: 0.1,
  });
  const body = JSON.parse(String(calls[0].init?.body));
  assert.equal(body.model, "codex-pro");
  assert.equal(body.max_tokens, 5);
  assert.equal(body.temperature, 0.1);

  mockFetch(() => new Response("boom", { status: 500 }));
  await assert.rejects(
    createCodexCompletion("k", "p", { baseUrl: BASE }),
    /Completion request failed: 500 - boom/,
  );
});
