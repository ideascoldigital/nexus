import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  SNIPPET_CHARS,
  attachRepoId,
  filterRepoHits,
  rankAndSlice,
  scoreFromDistance,
  toHit,
  type ScoredRecord,
} from "./ranking";

/** A stored chunk as LanceDB hands it back, with overridable columns. */
function record(over: Partial<ScoredRecord> = {}): ScoredRecord {
  return {
    id: "c1",
    source_type: "file",
    source_id: "s1",
    repo_id: "r1",
    file_path: "src/app.ts",
    chunk_index: 0,
    start_line: 0,
    end_line: 0,
    heading: "",
    text: "hello",
    vector: [],
    updated_at: 0,
    _distance: 0,
    ...over,
  };
}

test("an exact match scores 1", () => {
  assert.equal(scoreFromDistance(0), 1);
});

test("score falls as distance grows", () => {
  assert.equal(scoreFromDistance(1), 0.5);
  assert.equal(scoreFromDistance(3), 0.25);
  assert.ok(scoreFromDistance(2) < scoreFromDistance(1));
  assert.ok(scoreFromDistance(100) < scoreFromDistance(99));
});

test("score stays inside (0, 1] however far the hit is", () => {
  for (const d of [0, 0.001, 1, 50, 1e6]) {
    const score = scoreFromDistance(d);
    assert.ok(score > 0 && score <= 1, `distance ${d} -> ${score}`);
  }
});

test("a missing distance is treated as an exact match", () => {
  // LanceDB omits _distance on some code paths; scoring must not yield NaN.
  assert.equal(scoreFromDistance(undefined), 1);
  assert.equal(scoreFromDistance(null), 1);
});

test("a hit carries its record's identity and location", () => {
  const hit = toHit(
    record({
      source_type: "message",
      source_id: "m7",
      chunk_index: 3,
      file_path: "conversation/c1/message/m7",
    }),
    "conversations"
  );
  assert.equal(hit.sourceType, "message");
  assert.equal(hit.sourceId, "m7");
  assert.equal(hit.chunkIndex, 3);
  assert.equal(hit.filePath, "conversation/c1/message/m7");
  assert.equal(hit.bucket, "conversations");
});

test("the bucket comes from the caller, not the record", () => {
  assert.equal(toHit(record(), "repo").bucket, "repo");
  assert.equal(toHit(record(), "project-data").bucket, "project-data");
});

test("empty and zero columns are reported as absent", () => {
  // LanceDB stores "" and 0 rather than null; those are not real values.
  const hit = toHit(
    record({ repo_id: "", start_line: 0, end_line: 0, heading: "" }),
    "project-data"
  );
  assert.equal(hit.repoId, undefined);
  assert.equal(hit.startLine, undefined);
  assert.equal(hit.endLine, undefined);
  assert.equal(hit.heading, undefined);
});

test("real line numbers and headings survive", () => {
  const hit = toHit(
    record({ repo_id: "r9", start_line: 12, end_line: 40, heading: "## Setup" }),
    "repo"
  );
  assert.equal(hit.repoId, "r9");
  assert.equal(hit.startLine, 12);
  assert.equal(hit.endLine, 40);
  assert.equal(hit.heading, "## Setup");
});

test("a long chunk is truncated to a snippet", () => {
  const hit = toHit(record({ text: "x".repeat(SNIPPET_CHARS + 500) }), "repo");
  assert.equal(hit.snippet.length, SNIPPET_CHARS);
});

test("a short chunk is returned whole", () => {
  const hit = toHit(record({ text: "short text" }), "repo");
  assert.equal(hit.snippet, "short text");
});

test("a chunk index of zero is kept, not dropped", () => {
  // The first chunk of every source has index 0 — a falsy check would lose it.
  assert.equal(toHit(record({ chunk_index: 0 }), "repo").chunkIndex, 0);
});

test("a missing chunk index falls back to zero", () => {
  const hit = toHit(
    record({ chunk_index: undefined as unknown as number }),
    "repo"
  );
  assert.equal(hit.chunkIndex, 0);
});


test("hits come back nearest first", () => {
  const ranked = rankAndSlice(
    [
      record({ source_id: "far", _distance: 10 }),
      record({ source_id: "near", _distance: 0.1 }),
      record({ source_id: "mid", _distance: 2 }),
    ],
    "repo",
    8
  );
  assert.deepEqual(
    ranked.map((h) => h.sourceId),
    ["near", "mid", "far"]
  );
});

test("only the best k hits are returned", () => {
  const records = Array.from({ length: 20 }, (_, i) =>
    record({ source_id: `s${i}`, _distance: i })
  );
  const ranked = rankAndSlice(records, "repo", 3);
  assert.equal(ranked.length, 3);
  assert.deepEqual(
    ranked.map((h) => h.sourceId),
    ["s0", "s1", "s2"]
  );
});

test("asking for more than exists returns everything", () => {
  const ranked = rankAndSlice([record(), record({ source_id: "s2" })], "repo", 50);
  assert.equal(ranked.length, 2);
});

test("k of zero returns nothing", () => {
  assert.deepEqual(rankAndSlice([record()], "repo", 0), []);
});

test("no records rank to no hits", () => {
  assert.deepEqual(rankAndSlice([], "repo", 8), []);
});

test("every ranked hit is scored and tagged with its bucket", () => {
  const ranked = rankAndSlice(
    [record({ _distance: 0 }), record({ source_id: "s2", _distance: 1 })],
    "conversations",
    8
  );
  assert.deepEqual(
    ranked.map((h) => h.score),
    [1, 0.5]
  );
  assert.ok(ranked.every((h) => h.bucket === "conversations"));
});

test("no repo filter keeps every hit", () => {
  const hits = [{ repo_id: "r1" }, { repo_id: "r2" }];
  assert.deepEqual(
    filterRepoHits(hits, { projectRepoIds: new Set(["r1", "r2"]) }),
    hits
  );
});

test("an empty repoIds list means 'any repo', not 'no repos'", () => {
  const hits = [{ repo_id: "r1" }, { repo_id: "r2" }];
  assert.deepEqual(
    filterRepoHits(hits, { repoIds: [], projectRepoIds: new Set(["r1", "r2"]) }),
    hits
  );
});

test("repoIds narrows the results to the repos asked for", () => {
  const hits = [{ repo_id: "r1" }, { repo_id: "r2" }, { repo_id: "r3" }];
  assert.deepEqual(
    filterRepoHits(hits, {
      repoIds: ["r1", "r3"],
      projectRepoIds: new Set(["r1", "r2", "r3"]),
    }),
    [{ repo_id: "r1" }, { repo_id: "r3" }]
  );
});

test("hits from another project's repo are dropped", () => {
  // A repo store is keyed by URL/path and shared across projects — without
  // this filter one project's search would leak another project's code.
  const hits = [{ repo_id: "mine" }, { repo_id: "someone-elses" }];
  assert.deepEqual(
    filterRepoHits(hits, { projectRepoIds: new Set(["mine"]) }),
    [{ repo_id: "mine" }]
  );
});

test("a project with no repositories cannot narrow anything", () => {
  const hits = [{ repo_id: "r1" }];
  assert.deepEqual(filterRepoHits(hits, { projectRepoIds: new Set() }), hits);
});

test("both filters apply together", () => {
  const hits = [{ repo_id: "r1" }, { repo_id: "r2" }, { repo_id: "r3" }];
  assert.deepEqual(
    filterRepoHits(hits, {
      repoIds: ["r1", "r3"],
      projectRepoIds: new Set(["r1", "r2"]),
    }),
    [{ repo_id: "r1" }]
  );
});

test("a requested repo outside the project is still dropped", () => {
  const hits = [{ repo_id: "outsider" }];
  assert.deepEqual(
    filterRepoHits(hits, {
      repoIds: ["outsider"],
      projectRepoIds: new Set(["mine"]),
    }),
    []
  );
});

test("filtering does not mutate the input", () => {
  const hits = [{ repo_id: "r1" }, { repo_id: "r2" }];
  filterRepoHits(hits, { repoIds: ["r1"], projectRepoIds: new Set(["r1"]) });
  assert.equal(hits.length, 2);
});

test("hits are re-stamped with the searching project's repo id", () => {
  // The shared store may have recorded a different project's repo id.
  const stamped = attachRepoId([{ repo_id: "stale", text: "a" }], "current");
  assert.deepEqual(stamped, [{ repo_id: "current", text: "a" }]);
});

test("re-stamping keeps the rest of the record intact", () => {
  const stamped = attachRepoId(
    [{ repo_id: "old", source_id: "s1", _distance: 0.5 }],
    "r9"
  );
  assert.deepEqual(stamped[0], {
    repo_id: "r9",
    source_id: "s1",
    _distance: 0.5,
  });
});

test("re-stamping does not mutate the input", () => {
  const original = [{ repo_id: "old" }];
  attachRepoId(original, "new");
  assert.equal(original[0].repo_id, "old");
});

test("re-stamped hits survive the project filter", () => {
  // attachRepoId runs before filterRepoHits in searchProject; the stamped id
  // is what the project filter matches against.
  const stamped = attachRepoId([{ repo_id: "whatever" }], "mine");
  assert.deepEqual(filterRepoHits(stamped, { projectRepoIds: new Set(["mine"]) }), [
    { repo_id: "mine" },
  ]);
});
