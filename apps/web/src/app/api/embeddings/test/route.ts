/**
 * Embed one or two texts and, for two, say how similar the model finds them.
 * The by-hand check behind Settings → AI Providers → Embeddings; see
 * lib/embedding-test.ts for why it exists.
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { checkEmbedderHealth, getEmbedder } from "@nexux/embeddings/embedder";

import { cosineSimilarity, type EmbeddingTestResult } from "@/lib/embedding-test";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({
  // Short on purpose: this is a check, not an indexing path.
  texts: z.array(z.string().trim().min(1).max(2000)).min(1).max(2),
});

export async function POST(req: NextRequest) {
  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Give one or two texts, up to 2000 characters each." }, { status: 400 });
  }

  // Say which of the two preconditions is missing, instead of letting the
  // embed call fail with Ollama's own message.
  const health = await checkEmbedderHealth("ollama-nomic");
  if (!health.ollamaReachable) {
    return NextResponse.json(
      { error: `Ollama isn't answering at ${health.host}.`, health },
      { status: 409 },
    );
  }
  if (!health.modelPresent) {
    return NextResponse.json(
      { error: `${health.modelName} isn't installed on ${health.host} — install it first.`, health },
      { status: 409 },
    );
  }

  const embedder = getEmbedder("ollama-nomic");
  const vectors: number[][] = [];
  const results: EmbeddingTestResult["results"] = [];
  try {
    for (const text of parsed.data.texts) {
      const started = performance.now();
      const { vector } = await embedder.embed(text);
      results.push({
        chars: text.length,
        latencyMs: Math.round(performance.now() - started),
        // A peek, not the vector: 768 floats are noise on a settings page.
        preview: vector.slice(0, 6).map((v) => Math.round(v * 1000) / 1000),
      });
      vectors.push(vector);
    }
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Embedding failed" },
      { status: 502 },
    );
  }

  const body: EmbeddingTestResult = {
    model: health.modelName,
    host: health.host,
    dimensions: vectors[0].length,
    results,
    similarity: vectors.length === 2 ? cosineSimilarity(vectors[0], vectors[1]) : null,
  };
  return NextResponse.json(body);
}
