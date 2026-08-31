// How raw vector hits become ranked search results. Split out of
// searchProject so it can be tested without Ollama or LanceDB: this file
// imports types only, never prisma or a store.

import type { Bucket, ChunkRecord } from "./store";
import type { SourceType } from "./chunker";

/** Longest snippet returned per hit; the rest of the chunk is dropped. */
export const SNIPPET_CHARS = 600;

export type ScoredRecord = ChunkRecord & { _distance: number };

export type SearchHit = {
  sourceType: SourceType;
  sourceId: string;
  chunkIndex: number;
  repoId?: string;
  filePath: string;
  snippet: string;
  startLine?: number;
  endLine?: number;
  heading?: string;
  score: number;
  bucket: Bucket;
};

/**
 * Distance (0 = identical, unbounded above) as a similarity in (0, 1].
 * Monotonically decreasing, so ordering by score is ordering by nearness.
 */
export function scoreFromDistance(distance: number | null | undefined): number {
  return 1 / (1 + (distance ?? 0));
}

/**
 * A stored chunk as the caller sees it. Falsy-but-present columns (LanceDB
 * writes "" and 0 rather than null) become undefined so they can be omitted.
 */
export function toHit(record: ScoredRecord, bucket: Bucket): SearchHit {
  return {
    sourceType: record.source_type as SourceType,
    sourceId: record.source_id,
    chunkIndex: record.chunk_index ?? 0,
    repoId: record.repo_id || undefined,
    filePath: record.file_path,
    snippet: record.text.slice(0, SNIPPET_CHARS),
    startLine: record.start_line || undefined,
    endLine: record.end_line || undefined,
    heading: record.heading || undefined,
    score: scoreFromDistance(record._distance),
    bucket,
  };
}

/**
 * Keep only repo hits the caller asked for and that belong to this project.
 * Each filter is skipped when its list is empty: no `repoIds` option means
 * "any repo", and a project with no repositories cannot narrow anything.
 *
 * The project filter matters because a repo store is keyed by repo URL/path
 * and therefore shared across every project pointing at that checkout.
 */
export function filterRepoHits<T extends { repo_id: string }>(
  hits: T[],
  opts: { repoIds?: string[]; projectRepoIds: Set<string> }
): T[] {
  return hits
    .filter((h) => !opts.repoIds?.length || opts.repoIds.includes(h.repo_id))
    .filter((h) => !opts.projectRepoIds.size || opts.projectRepoIds.has(h.repo_id));
}

/** Best `k` hits for one bucket, nearest first. */
export function rankAndSlice(
  records: ScoredRecord[],
  bucket: Bucket,
  k: number
): SearchHit[] {
  return records
    .map((r) => toHit(r, bucket))
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
}

/**
 * Repo hits carry the repo id of the project being searched, not whatever the
 * shared store happened to record when another project indexed the checkout.
 */
export function attachRepoId<T extends object>(hits: T[], repoId: string) {
  return hits.map((h) => ({ ...h, repo_id: repoId }));
}
