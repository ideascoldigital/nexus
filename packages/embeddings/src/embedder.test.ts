import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  Embedder,
  OllamaUnavailableError,
  dimensionsFor,
} from "./embedder";

// The Embedder talks to Ollama through a single client instance; tests swap it
// for a fake to exercise the retry/truncation logic without a daemon.
type FakeOllama = {
  list?: () => Promise<{ models: { name: string }[] }>;
  pull?: (opts: { model: string }) => Promise<void>;
  embeddings?: (opts: { model: string; prompt: string }) => Promise<{ embedding: number[] }>;
};

function withFake(fake: FakeOllama): Embedder {
  const e = new Embedder({ provider: "ollama-nomic" });
  (e as unknown as { ollama: FakeOllama }).ollama = fake;
  return e;
}

test("dimensionsFor maps providers to vector sizes", () => {
  assert.equal(dimensionsFor("ollama-nomic"), 768);
  assert.equal(dimensionsFor("local-minilm"), 384);
  assert.equal(dimensionsFor("openai-3-small"), 1536);
  assert.equal(dimensionsFor("openai-3-large"), 3072);
});

test("constructor exposes provider and dimensions", () => {
  const e = new Embedder({ provider: "ollama-nomic" });
  assert.equal(e.provider, "ollama-nomic");
  assert.equal(e.dimensions, 768);
});

test("non-implemented providers throw on ensureReady and embed", async () => {
  const e = new Embedder({ provider: "openai-3-small" });
  await assert.rejects(e.ensureReady(), /not implemented/);
  await assert.rejects(e.embed("x"), /not implemented/);
});

test("ensureReady throws OllamaUnavailableError when the daemon is down", async () => {
  const e = withFake({
    list: async () => {
      throw new Error("ECONNREFUSED");
    },
  });
  await assert.rejects(e.ensureReady(), OllamaUnavailableError);
});

test("ensureReady pulls the model only when missing", async () => {
  let pulled = 0;
  const e = withFake({
    list: async () => ({ models: [{ name: "llama3:latest" }] }),
    pull: async () => {
      pulled++;
    },
  });
  await e.ensureReady();
  assert.equal(pulled, 1);

  const e2 = withFake({
    list: async () => ({ models: [{ name: "nomic-embed-text:latest" }] }),
    pull: async () => {
      pulled++;
    },
  });
  await e2.ensureReady();
  assert.equal(pulled, 1);
});

test("embed returns the vector and its true dimensions", async () => {
  const e = withFake({
    embeddings: async () => ({ embedding: [0.1, 0.2, 0.3] }),
  });
  const res = await e.embed("hola");
  assert.deepEqual(res.vector, [0.1, 0.2, 0.3]);
  assert.equal(res.dimensions, 3);
});

test("embed truncates input to the 8000-char cap", async () => {
  const prompts: string[] = [];
  const e = withFake({
    embeddings: async ({ prompt }) => {
      prompts.push(prompt);
      return { embedding: [1] };
    },
  });
  await e.embed("x".repeat(20_000));
  assert.equal(prompts.length, 1);
  assert.equal(prompts[0].length, 8000);
});

test("embed halves the input on context-overflow errors until it fits", async () => {
  const prompts: string[] = [];
  const e = withFake({
    embeddings: async ({ prompt }) => {
      prompts.push(prompt);
      if (prompt.length > 1000) {
        throw new Error("input exceeds the context length of the model");
      }
      return { embedding: [1, 2] };
    },
  });
  const res = await e.embed("y".repeat(8000));
  assert.deepEqual(
    prompts.map((p) => p.length),
    [8000, 4000, 2000, 1000],
  );
  assert.equal(res.dimensions, 2);
});

test("embed gives up below the 200-char floor", async () => {
  const e = withFake({
    embeddings: async () => {
      throw new Error("context length exceeded");
    },
  });
  await assert.rejects(e.embed("z".repeat(300)), /context length/);
});

test("embed propagates non-overflow errors immediately", async () => {
  let calls = 0;
  const e = withFake({
    embeddings: async () => {
      calls++;
      throw new Error("model not found");
    },
  });
  await assert.rejects(e.embed("x".repeat(5000)), /model not found/);
  assert.equal(calls, 1);
});

test("embedBatch preserves order", async () => {
  const e = withFake({
    embeddings: async ({ prompt }) => ({ embedding: [prompt.length] }),
  });
  const out = await e.embedBatch(["a", "bb", "ccc"]);
  assert.deepEqual(
    out.map((r) => r.vector[0]),
    [1, 2, 3],
  );
});
