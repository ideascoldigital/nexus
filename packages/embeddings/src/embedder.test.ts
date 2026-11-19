import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  Embedder,
  OllamaUnavailableError,
  checkEmbedderHealth,
  dimensionsFor,
  getEmbedder,
  resolveOllamaHost,
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

// --- host resolution --------------------------------------------------------
// The saved "Ollama URL" setting must win over OLLAMA_URL, which must win over
// localhost. Each test sets OLLAMA_URL itself and restores it afterwards.

function withOllamaEnv(value: string | undefined, fn: () => void | Promise<void>) {
  const before = process.env.OLLAMA_URL;
  if (value === undefined) delete process.env.OLLAMA_URL;
  else process.env.OLLAMA_URL = value;
  const restore = () => {
    if (before === undefined) delete process.env.OLLAMA_URL;
    else process.env.OLLAMA_URL = before;
  };
  try {
    const out = fn();
    if (out instanceof Promise) return out.finally(restore);
    restore();
  } catch (err) {
    restore();
    throw err;
  }
}

test("a saved Ollama URL wins over OLLAMA_URL", () =>
  withOllamaEnv("http://env-ollama:11434", () => {
    assert.deepEqual(resolveOllamaHost("http://gpu-box:11434"), {
      host: "http://gpu-box:11434",
      source: "setting",
    });
  }));

test("with no saved URL, OLLAMA_URL is used", () =>
  withOllamaEnv("http://env-ollama:11434", () => {
    for (const saved of [undefined, null, "", "   "]) {
      assert.deepEqual(resolveOllamaHost(saved), {
        host: "http://env-ollama:11434",
        source: "env",
      });
    }
  }));

test("with neither, localhost is the default", () =>
  withOllamaEnv(undefined, () => {
    assert.deepEqual(resolveOllamaHost(), {
      host: "http://localhost:11434",
      source: "default",
    });
  }));

test("an empty OLLAMA_URL falls back to localhost instead of an empty host", () =>
  withOllamaEnv("", () => {
    assert.equal(resolveOllamaHost().host, "http://localhost:11434");
  }));

test("a saved URL is trimmed and loses trailing slashes", () =>
  withOllamaEnv(undefined, () => {
    assert.equal(resolveOllamaHost("  http://gpu-box:11434//  ").host, "http://gpu-box:11434");
  }));

test("an unusable saved URL falls through to the next source", () =>
  withOllamaEnv("http://env-ollama:11434", () => {
    for (const bad of ["localhost:11434", "not a url", "ftp://gpu-box"]) {
      assert.equal(resolveOllamaHost(bad).source, "env", bad);
    }
  }));

test("OLLAMA_URL is read per call, not frozen at import", () => {
  withOllamaEnv("http://first:11434", () => {
    assert.equal(resolveOllamaHost().host, "http://first:11434");
  });
  withOllamaEnv("http://second:11434", () => {
    assert.equal(resolveOllamaHost().host, "http://second:11434");
  });
});

test("an Embedder talks to the host it is given", () =>
  withOllamaEnv("http://env-ollama:11434", () => {
    assert.equal(new Embedder({ provider: "ollama-nomic", ollamaHost: "http://gpu-box:11434" }).host, "http://gpu-box:11434");
    assert.equal(getEmbedder("ollama-nomic", "http://gpu-box:11434").host, "http://gpu-box:11434");
    assert.equal(getEmbedder("ollama-nomic").host, "http://env-ollama:11434");
  }));

test("the unreachable error names the host that was actually tried", async () => {
  const e = new Embedder({ provider: "ollama-nomic", ollamaHost: "http://gpu-box:11434" });
  (e as unknown as { ollama: FakeOllama }).ollama = {
    list: async () => {
      throw new Error("ECONNREFUSED");
    },
  };
  await assert.rejects(e.ensureReady(), /Cannot reach Ollama at http:\/\/gpu-box:11434/);
});

test("the health check reports the host it was given", async () => {
  // Port 1 refuses at once: this exercises the unreachable path without a daemon.
  const health = await checkEmbedderHealth("ollama-nomic", "http://127.0.0.1:1");
  assert.equal(health.host, "http://127.0.0.1:1");
  assert.equal(health.ollamaReachable, false);
});

test("the health check falls back to the resolved host", () =>
  withOllamaEnv("http://127.0.0.1:1", async () => {
    const health = await checkEmbedderHealth("openai-3-small");
    assert.equal(health.host, "http://127.0.0.1:1");
  }));
