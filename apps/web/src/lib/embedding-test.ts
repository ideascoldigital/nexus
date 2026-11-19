/**
 * Checking the embedding model by hand: embed two texts and compare them.
 *
 * Health says Ollama answers and the model is installed; it cannot say the
 * model produces useful vectors. Two texts that mean the same thing scoring
 * well above two that do not is the whole contract search relies on, and it
 * is checkable in a second — so Settings offers exactly that.
 */

/** Cosine similarity in [-1, 1]; 0 for a zero or mismatched vector. */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na === 0 || nb === 0 ? 0 : dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * How to read a nomic-embed-text similarity. The bands are for this model —
 * its scores for unrelated text sit well above zero — not a universal scale.
 */
export function describeSimilarity(score: number): string {
  if (score >= 0.8) return "very close — the model reads these as the same idea";
  if (score >= 0.65) return "related";
  if (score >= 0.5) return "loosely related";
  return "unrelated";
}

/** What the test route returns. */
export type EmbeddingTestResult = {
  model: string;
  host: string;
  dimensions: number;
  results: Array<{ chars: number; latencyMs: number; preview: number[] }>;
  /** Present when two texts were embedded. */
  similarity: number | null;
};
