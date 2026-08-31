import assert from "node:assert/strict";
import fs from "node:fs";
import { after, test } from "node:test";

// Env setup must stay above the service import — this module reaches
// @nexux/db, whose client is built at module load.
import { testDbDir } from "./services.test-setup";
import { ApiError, startPreview } from "./sandbox";

after(() => {
  fs.rmSync(testDbDir, { recursive: true, force: true });
});

/** Swap global fetch for one canned response, restoring it afterwards. */
async function withFetch<T>(
  response: { ok: boolean; body: unknown },
  run: () => Promise<T>,
): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => ({
    ok: response.ok,
    json: async () => response.body,
  })) as unknown as typeof fetch;
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
  }
}

test("startPreview returns the url on success", async () => {
  const result = await withFetch(
    { ok: true, body: { previewUrl: "https://x.trycloudflare.com" } },
    () => startPreview("p1", "s1"),
  );
  assert.equal(result.previewUrl, "https://x.trycloudflare.com");
});

test("startPreview carries the server log tail on failure", async () => {
  const err = await withFetch(
    {
      ok: false,
      body: {
        error: "The app did not start, or the tunnel could not open.",
        log: "[nexux] WARN: the app did not start\nError: listen EADDRINUSE :::3000",
      },
    },
    () => startPreview("p1", "s1").then(() => null, (e: unknown) => e),
  );

  assert.ok(err instanceof ApiError);
  assert.match(err.message, /did not start/);
  assert.match(err.log ?? "", /EADDRINUSE/);
});

test("startPreview leaves log undefined when the body has none", async () => {
  const err = await withFetch(
    { ok: false, body: { error: "Sandbox is not running" } },
    () => startPreview("p1", "s1").then(() => null, (e: unknown) => e),
  );

  assert.ok(err instanceof ApiError);
  assert.equal(err.message, "Sandbox is not running");
  assert.equal(err.log, undefined);
});

test("startPreview ignores a blank log", async () => {
  const err = await withFetch(
    { ok: false, body: { error: "boom", log: "   \n  " } },
    () => startPreview("p1", "s1").then(() => null, (e: unknown) => e),
  );

  assert.ok(err instanceof ApiError);
  assert.equal(err.log, undefined);
});

test("startPreview falls back when the error body is unusable", async () => {
  const err = await withFetch(
    { ok: false, body: { error: 42 } },
    () => startPreview("p1", "s1").then(() => null, (e: unknown) => e),
  );

  assert.ok(err instanceof ApiError);
  assert.equal(err.message, "Could not start the preview");
});
