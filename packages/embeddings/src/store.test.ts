import { strict as assert } from "node:assert";
import { after, test } from "node:test";
import fs from "fs";
import path from "path";

// store.ts resolves INDEXES_ROOT from NEXUX_DATA_DIR at module load — the
// setup import must stay above ./store so the env var is set first.
import { testDataDir as dataDir } from "./store.test-setup";
import { VectorStore, bucketDir, projectSlug, repoKeyFor } from "./store";

after(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const DIMS = 4;

function record(
  id: string,
  vector: number[],
  extra: Partial<{ source_type: string; source_id: string; repo_id: string; text: string }> = {},
) {
  return {
    id,
    source_type: extra.source_type ?? "file",
    source_id: extra.source_id ?? id,
    repo_id: extra.repo_id ?? "r1",
    file_path: `${id}.ts`,
    chunk_index: 0,
    start_line: 1,
    end_line: 1,
    heading: "",
    text: extra.text ?? id,
    vector,
    updated_at: 1,
  };
}

test("repoKeyFor normalizes URLs: .git suffix, trailing slash, case", () => {
  const base = repoKeyFor({ repoUrl: "https://github.com/acme/repo" });
  assert.equal(repoKeyFor({ repoUrl: "https://github.com/acme/repo.git" }), base);
  assert.equal(repoKeyFor({ repoUrl: "https://github.com/acme/repo/" }), base);
  assert.equal(repoKeyFor({ repoUrl: "HTTPS://GitHub.com/ACME/repo" }), base);
  assert.match(base, /^url-[0-9a-f]{16}$/);
});

test("repoKeyFor falls back to resolved localPath, then random unknown", () => {
  const a = repoKeyFor({ localPath: "/repos/api" });
  const b = repoKeyFor({ localPath: "/repos/../repos/api" });
  assert.equal(a, b);
  assert.match(a, /^path-[0-9a-f]{16}$/);

  const u1 = repoKeyFor({});
  const u2 = repoKeyFor({ repoUrl: "  ", localPath: null });
  assert.match(u1, /^unknown-[0-9a-f]{16}$/);
  assert.notEqual(u1, u2);
});

test("bucketDir sanitizes keys and routes buckets", () => {
  const dir = bucketDir("repo", "url-abc123");
  assert.equal(dir, path.join(dataDir, "indexes", "repos", "url-abc123", "lancedb"));
  assert.equal(
    bucketDir("conversations", "a/b:c"),
    path.join(dataDir, "indexes", "conversations", "a_b_c", "lancedb"),
  );
  assert.ok(bucketDir("project-data", "k").includes(path.join("indexes", "project-data")));
});

test("projectSlug takes the first 8 chars", () => {
  assert.equal(projectSlug("abcdef12-3456"), "abcdef12");
});

test("VectorStore round-trip: open, upsert, search by similarity", async () => {
  const store = await VectorStore.open("repo", "test-roundtrip", DIMS);
  await store.upsertChunks([
    record("near", [1, 0, 0, 0]),
    record("far", [0, 0, 0, 1]),
  ]);

  const hits = await store.search([0.9, 0.1, 0, 0], 2);
  assert.equal(hits.length, 2);
  assert.equal(hits[0].id, "near");
  assert.ok(hits[0]._distance <= hits[1]._distance);
});

test("upsertChunks replaces records with the same id", async () => {
  const store = await VectorStore.open("repo", "test-upsert", DIMS);
  await store.upsertChunks([record("a", [1, 0, 0, 0], { text: "v1" })]);
  await store.upsertChunks([record("a", [1, 0, 0, 0], { text: "v2" })]);

  const hits = await store.search([1, 0, 0, 0], 10);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].text, "v2");
});

test("search filters by sourceTypes and repoIds", async () => {
  const store = await VectorStore.open("repo", "test-filters", DIMS);
  await store.upsertChunks([
    record("f1", [1, 0, 0, 0], { source_type: "file", repo_id: "r1" }),
    record("m1", [1, 0, 0, 0], { source_type: "message", repo_id: "r2" }),
  ]);

  const files = await store.search([1, 0, 0, 0], 10, { sourceTypes: ["file"] });
  assert.deepEqual(files.map((h) => h.id), ["f1"]);

  const r2 = await store.search([1, 0, 0, 0], 10, { repoIds: ["r2"] });
  assert.deepEqual(r2.map((h) => h.id), ["m1"]);

  const both = await store.search([1, 0, 0, 0], 10, {
    sourceTypes: ["file"],
    repoIds: ["r2"],
  });
  assert.equal(both.length, 0);
});

test("deleteBySource removes only the matching source", async () => {
  const store = await VectorStore.open("repo", "test-delete", DIMS);
  await store.upsertChunks([
    record("keep", [1, 0, 0, 0], { source_type: "file", source_id: "s-keep" }),
    record("drop", [0, 1, 0, 0], { source_type: "file", source_id: "s-drop" }),
  ]);

  await store.deleteBySource("file", "s-drop");
  const hits = await store.search([1, 0, 0, 0], 10);
  assert.deepEqual(hits.map((h) => h.id), ["keep"]);
});

test("deleteBySource escapes single quotes in sourceId", async () => {
  const store = await VectorStore.open("repo", "test-escape", DIMS);
  await store.upsertChunks([
    record("q", [1, 0, 0, 0], { source_id: "it's" }),
  ]);
  await store.deleteBySource("file", "it's");
  const hits = await store.search([1, 0, 0, 0], 10);
  assert.equal(hits.length, 0);
});

test("dropAll wipes the table and leaves a clean dir", async () => {
  const store = await VectorStore.open("repo", "test-drop", DIMS);
  await store.upsertChunks([record("x", [1, 0, 0, 0])]);
  await store.dropAll();
  assert.ok(fs.existsSync(bucketDir("repo", "test-drop")));

  const reopened = await VectorStore.open("repo", "test-drop", DIMS);
  const hits = await reopened.search([1, 0, 0, 0], 10);
  assert.equal(hits.length, 0);
});
