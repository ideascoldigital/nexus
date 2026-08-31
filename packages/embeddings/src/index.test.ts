import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  indexProject,
  dropProjectIndex,
  isLanceCorruption,
  searchProject,
} from "./index";
import type {
  EmbeddingDeps,
  IndexStore,
  ScannedFileRef,
} from "./deps";
import type { ChunkRecord } from "./store";
import { projectSlug, repoKeyFor } from "./store";

// --- fakes -----------------------------------------------------------------
// indexProject reaches prisma, Ollama and LanceDB; all three arrive through
// the deps seam, so the tests below run with no daemon and no disk.

type IndexEntry = {
  id: string;
  projectId: string;
  contentHash: string;
  provider: string;
};

type Project = Parameters<typeof buildProject>[0];

function buildProject(over: {
  repositories?: { id: string; localPath?: string | null; repoUrl?: string | null }[];
  features?: {
    id: string;
    title: string;
    description?: string | null;
    aiRefinement?: string | null;
  }[];
  document?: {
    sections: { id: string; key: string; title: string; content: string }[];
  } | null;
  projectSkills?: {
    skill?: {
      id: string;
      name: string;
      description?: string | null;
      body?: string | null;
    } | null;
  }[];
  conversations?: {
    id: string;
    name?: string | null;
    messages: {
      id: string;
      role: string;
      agentRole?: string | null;
      content?: string | null;
    }[];
  }[];
} = {}) {
  return {
    repositories: over.repositories ?? [],
    features: over.features ?? [],
    document: over.document ?? null,
    projectSkills: over.projectSkills ?? [],
    conversations: over.conversations ?? [],
  };
}

/** A stored chunk plus its distance, as a store returns it from search. */
type Hit = ChunkRecord & { _distance: number };

type Harness = {
  deps: EmbeddingDeps;
  /** Every chunk written to a store, in write order. */
  written: { key: string; records: ChunkRecord[] }[];
  entries: Map<string, IndexEntry>;
  dropped: string[];
  deletedEntries: object[];
  deletedSources: { sourceType: string; sourceId: string }[];
  embedCalls: string[];
  openedStores: string[];
  openedDimensions: number[];
  searches: {
    key: string;
    vector: number[];
    k: number;
    filters?: { sourceTypes?: string[]; repoIds?: string[] };
  }[];
  ensureReadyCalls: number;
};

function harness(opts: {
  project?: ReturnType<typeof buildProject> | null;
  repos?: { id: string; repoUrl?: string | null; localPath?: string | null }[] | null;
  files?: Record<string, ScannedFileRef[]>;
  fileContents?: Record<string, string>;
  entries?: IndexEntry[];
  unreadable?: string[];
  /** Search results keyed by `${bucket}:${key}`. */
  hits?: Record<string, Hit[]>;
  onOpenStore?: (bucket: string, key: string) => void;
  onUpsert?: (key: string) => void;
} = {}): Harness {
  const written: Harness["written"] = [];
  const entries = new Map<string, IndexEntry>();
  const dropped: string[] = [];
  const deletedEntries: object[] = [];
  const deletedSources: Harness["deletedSources"] = [];
  const embedCalls: string[] = [];
  const openedStores: string[] = [];
  const openedDimensions: number[] = [];
  const searches: Harness["searches"] = [];
  let ensureReadyCalls = 0;

  for (const e of opts.entries ?? []) {
    entries.set(e.id, e);
  }

  const entryKey = (w: {
    bucket: string;
    indexKey: string;
    sourceType: string;
    sourceId: string;
  }) => `${w.bucket}|${w.indexKey}|${w.sourceType}|${w.sourceId}`;

  const makeStore = (storeKey: string): IndexStore => ({
    dropAll: async () => {
      dropped.push(storeKey);
    },
    deleteBySource: async (sourceType, sourceId) => {
      deletedSources.push({ sourceType, sourceId });
    },
    upsertChunks: async (records) => {
      opts.onUpsert?.(storeKey);
      written.push({ key: storeKey, records });
    },
    search: async (vector, k, filters) => {
      searches.push({ key: storeKey, vector, k, filters });
      return opts.hits?.[storeKey] ?? [];
    },
  });

  const deps: EmbeddingDeps = {
    db: {
      findProject: async () =>
        opts.project === undefined ? buildProject() : opts.project,
      findProjectRepos: async () =>
        opts.repos === undefined
          ? { repositories: [] }
          : opts.repos === null
            ? null
            : { repositories: opts.repos },
      findIndexEntry: async (where) => entries.get(entryKey(where)) ?? null,
      touchIndexEntry: async (id, projectId) => {
        for (const [k, v] of entries) {
          if (v.id === id) entries.set(k, { ...v, projectId });
        }
      },
      upsertIndexEntry: async (entry) => {
        entries.set(entryKey(entry), {
          id: entryKey(entry),
          projectId: entry.projectId,
          contentHash: entry.contentHash,
          provider: entry.provider,
        });
      },
      deleteIndexEntries: async (where) => {
        deletedEntries.push(where);
      },
    },
    getEmbedder: () => ({
      ensureReady: async () => {
        ensureReadyCalls++;
      },
      embed: async (text) => {
        embedCalls.push(text);
        return { vector: [0.1, 0.2, 0.3] };
      },
    }),
    openStore: async (bucket, key, dimensions) => {
      const storeKey = `${bucket}:${key}`;
      openedStores.push(storeKey);
      openedDimensions.push(dimensions);
      opts.onOpenStore?.(bucket, key);
      return makeStore(storeKey);
    },
    scanRepo: (rootPath) => opts.files?.[rootPath] ?? [],
    readFile: (absolutePath) => {
      if (opts.unreadable?.includes(absolutePath)) {
        throw new Error("EACCES");
      }
      return opts.fileContents?.[absolutePath] ?? "file body";
    },
    now: () => 1_000,
  };

  return {
    deps,
    written,
    entries,
    dropped,
    deletedEntries,
    deletedSources,
    embedCalls,
    openedStores,
    openedDimensions,
    searches,
    get ensureReadyCalls() {
      return ensureReadyCalls;
    },
  } as Harness;
}

const entryKeyFor = (
  bucket: string,
  indexKey: string,
  sourceType: string,
  sourceId: string
) => `${bucket}|${indexKey}|${sourceType}|${sourceId}`;

// --- corruption detection ---------------------------------------------------

test("a LanceDB missing-file error is recognized as corruption", () => {
  assert.equal(
    isLanceCorruption(
      "LanceError(IO): Not found: /data/indexes/repo/x/lancedb/data/foo.lance"
    ),
    true
  );
});

test("an unrelated error is not corruption", () => {
  assert.equal(isLanceCorruption("ECONNREFUSED talking to Ollama"), false);
  assert.equal(isLanceCorruption("LanceError(IO): permission denied"), false);
  assert.equal(isLanceCorruption("Not found: some.lance"), false);
});

// --- reporting --------------------------------------------------------------

test("a missing project is reported, not silently skipped", async () => {
  const h = harness({ project: null });
  await assert.rejects(
    () => indexProject("p1", {}, h.deps),
    /Project p1 not found/
  );
});

test("the embedder is made ready before anything is embedded", async () => {
  const h = harness({
    project: buildProject({
      features: [{ id: "f1", title: "Login" }],
    }),
  });
  await indexProject("p1", {}, h.deps);
  assert.equal(h.ensureReadyCalls, 1);
});

test("an empty project reports zero work", async () => {
  const h = harness({ project: buildProject() });
  const report = await indexProject("p1", {}, h.deps);
  assert.equal(report.scanned, 0);
  assert.equal(report.embedded, 0);
  assert.equal(report.skipped, 0);
  assert.deepEqual(report.buckets, { repos: 0, conversations: 0, projectData: 0 });
});

test("the report echoes the provider and its dimensions", async () => {
  const h = harness();
  const report = await indexProject("p1", {}, h.deps);
  assert.equal(report.projectId, "p1");
  assert.equal(report.provider, "ollama-nomic");
  assert.equal(report.dimensions, 768);
});

test("durationMs is measured with the injected clock", async () => {
  const h = harness();
  const report = await indexProject("p1", {}, h.deps);
  assert.equal(report.durationMs, 0);
});

// --- what gets indexed ------------------------------------------------------

test("document sections, features and skills land in project-data", async () => {
  const h = harness({
    project: buildProject({
      document: {
        sections: [{ id: "s1", key: "overview", title: "Overview", content: "body" }],
      },
      features: [{ id: "f1", title: "Login", description: "desc" }],
      projectSkills: [{ skill: { id: "sk1", name: "deploy", body: "steps" } }],
    }),
  });
  const report = await indexProject("p1", {}, h.deps);
  assert.equal(report.scanned, 3);
  assert.equal(report.embedded, 3);
  assert.equal(report.buckets.projectData, 3);
});

test("a skill row with no skill attached is skipped entirely", async () => {
  const h = harness({
    project: buildProject({ projectSkills: [{ skill: null }] }),
  });
  const report = await indexProject("p1", {}, h.deps);
  assert.equal(report.scanned, 0);
});

test("a feature's title, description and refinement are indexed together", async () => {
  const h = harness({
    project: buildProject({
      features: [
        {
          id: "f1",
          title: "Login",
          description: "users sign in",
          aiRefinement: "with OAuth",
        },
      ],
    }),
  });
  await indexProject("p1", {}, h.deps);
  const text = h.embedCalls[0];
  assert.match(text, /# Login/);
  assert.match(text, /users sign in/);
  assert.match(text, /with OAuth/);
});

test("a feature's empty fields do not leave blank gaps", async () => {
  const h = harness({
    project: buildProject({
      features: [{ id: "f1", title: "Login", description: null, aiRefinement: null }],
    }),
  });
  await indexProject("p1", {}, h.deps);
  assert.equal(h.embedCalls[0], "# Login");
});

test("messages are indexed with their role and conversation", async () => {
  const h = harness({
    project: buildProject({
      conversations: [
        {
          id: "c1",
          name: "Planning",
          messages: [
            {
              id: "m1",
              role: "user",
              content: "a message long enough to be indexed",
            },
          ],
        },
      ],
    }),
  });
  const report = await indexProject("p1", {}, h.deps);
  assert.equal(report.buckets.conversations, 1);
  assert.match(h.embedCalls[0], /# user in Planning/);
});

test("an agent role is named in the message header", async () => {
  const h = harness({
    project: buildProject({
      conversations: [
        {
          id: "c1",
          name: "Planning",
          messages: [
            {
              id: "m1",
              role: "assistant",
              agentRole: "architect",
              content: "a message long enough to be indexed",
            },
          ],
        },
      ],
    }),
  });
  await indexProject("p1", {}, h.deps);
  assert.match(h.embedCalls[0], /# assistant \(architect\) in Planning/);
});

test("an unnamed conversation is labelled by its id prefix", async () => {
  const h = harness({
    project: buildProject({
      conversations: [
        {
          id: "abcdefgh-1234",
          name: null,
          messages: [
            { id: "m1", role: "user", content: "a message long enough to index" },
          ],
        },
      ],
    }),
  });
  await indexProject("p1", {}, h.deps);
  assert.match(h.embedCalls[0], /in abcdefgh$/m);
});

test("a message shorter than the minimum is not indexed", async () => {
  // Short messages are "ok", "thanks" — noise that would dilute search.
  const h = harness({
    project: buildProject({
      conversations: [
        { id: "c1", messages: [{ id: "m1", role: "user", content: "ok" }] },
      ],
    }),
  });
  const report = await indexProject("p1", {}, h.deps);
  assert.equal(report.scanned, 0);
  assert.equal(h.embedCalls.length, 0);
});

test("a message is measured after trimming", async () => {
  const h = harness({
    project: buildProject({
      conversations: [
        {
          id: "c1",
          messages: [{ id: "m1", role: "user", content: `   ok   ${" ".repeat(40)}` }],
        },
      ],
    }),
  });
  const report = await indexProject("p1", {}, h.deps);
  assert.equal(report.scanned, 0);
});

test("repo files are indexed into the repo bucket", async () => {
  const h = harness({
    project: buildProject({
      repositories: [{ id: "r1", localPath: "/repo", repoUrl: "https://x/y.git" }],
    }),
    files: {
      "/repo": [
        { absolutePath: "/repo/a.ts", relativePath: "a.ts" },
        { absolutePath: "/repo/b.ts", relativePath: "b.ts" },
      ],
    },
  });
  const report = await indexProject("p1", {}, h.deps);
  assert.equal(report.buckets.repos, 2);
  assert.equal(report.embedded, 2);
});

test("a repository with no local checkout is skipped", async () => {
  const h = harness({
    project: buildProject({ repositories: [{ id: "r1", localPath: null }] }),
  });
  const report = await indexProject("p1", {}, h.deps);
  assert.equal(report.scanned, 0);
  assert.equal(h.openedStores.filter((s) => s.startsWith("repo:")).length, 0);
});

test("a file that cannot be read is skipped without failing the run", async () => {
  const h = harness({
    project: buildProject({ repositories: [{ id: "r1", localPath: "/repo" }] }),
    files: {
      "/repo": [
        { absolutePath: "/repo/locked.ts", relativePath: "locked.ts" },
        { absolutePath: "/repo/ok.ts", relativePath: "ok.ts" },
      ],
    },
    unreadable: ["/repo/locked.ts"],
  });
  const report = await indexProject("p1", {}, h.deps);
  assert.equal(report.scanned, 1);
  assert.equal(report.embedded, 1);
});

// --- incremental vs full ----------------------------------------------------

test("unchanged content is skipped on an incremental run", async () => {
  const first = harness({
    project: buildProject({ features: [{ id: "f1", title: "Login" }] }),
  });
  const report1 = await indexProject("p1", {}, first.deps);
  assert.equal(report1.embedded, 1);

  // Re-run with the entry the first pass recorded.
  const second = harness({
    project: buildProject({ features: [{ id: "f1", title: "Login" }] }),
    entries: [...first.entries.values()].map((e) => ({ ...e })),
  });
  // Re-key the entries the way the fake db looks them up.
  second.entries.clear();
  for (const [k, v] of first.entries) second.entries.set(k, v);

  const report2 = await indexProject("p1", {}, second.deps);
  assert.equal(report2.skipped, 1);
  assert.equal(report2.embedded, 0);
  assert.equal(second.embedCalls.length, 0);
});

test("changed content is re-embedded on an incremental run", async () => {
  const first = harness({
    project: buildProject({ features: [{ id: "f1", title: "Login" }] }),
  });
  await indexProject("p1", {}, first.deps);

  const second = harness({
    project: buildProject({ features: [{ id: "f1", title: "Login rewritten" }] }),
  });
  for (const [k, v] of first.entries) second.entries.set(k, v);

  const report = await indexProject("p1", {}, second.deps);
  assert.equal(report.embedded, 1);
  assert.equal(report.skipped, 0);
});

test("a provider change forces a re-embed even when the text is identical", async () => {
  // Vectors from different models are not comparable, so the old ones must go.
  const slug = projectSlug("p1");
  const h = harness({
    project: buildProject({ features: [{ id: "f1", title: "Login" }] }),
  });
  const first = await indexProject("p1", {}, h.deps);
  assert.equal(first.embedded, 1);

  const key = entryKeyFor("project-data", slug, "feature", "f1");
  const stored = h.entries.get(key);
  assert.ok(stored);
  h.entries.set(key, { ...stored, provider: "some-other-model" });
  h.embedCalls.length = 0;

  const second = await indexProject("p1", {}, h.deps);
  assert.equal(second.embedded, 1);
  assert.equal(second.skipped, 0);
});

test("a full run re-embeds content an incremental run would skip", async () => {
  const first = harness({
    project: buildProject({ features: [{ id: "f1", title: "Login" }] }),
  });
  await indexProject("p1", {}, first.deps);

  const second = harness({
    project: buildProject({ features: [{ id: "f1", title: "Login" }] }),
  });
  for (const [k, v] of first.entries) second.entries.set(k, v);

  const report = await indexProject("p1", { mode: "full" }, second.deps);
  assert.equal(report.embedded, 1);
  assert.equal(report.skipped, 0);
});

test("a full run drops the per-project stores and their tracking rows", async () => {
  const slug = projectSlug("p1");
  const h = harness({ project: buildProject() });
  await indexProject("p1", { mode: "full" }, h.deps);

  assert.ok(h.dropped.includes(`project-data:${slug}`));
  assert.ok(h.dropped.includes(`conversations:${slug}`));
  assert.deepEqual(h.deletedEntries, [
    { bucket: "project-data", indexKey: slug },
    { bucket: "conversations", indexKey: slug },
  ]);
});

test("an incremental run drops nothing", async () => {
  const h = harness({
    project: buildProject({ features: [{ id: "f1", title: "Login" }] }),
  });
  await indexProject("p1", {}, h.deps);
  assert.deepEqual(h.dropped, []);
  assert.deepEqual(h.deletedEntries, []);
});

test("a shared repo picks up the current project without re-embedding", async () => {
  // Two projects pointing at one checkout share the repo store; the second
  // project must claim the tracking row rather than redo the work.
  const slug = projectSlug("p1");
  const first = harness({
    project: buildProject({ repositories: [{ id: "r1", localPath: "/repo" }] }),
    files: { "/repo": [{ absolutePath: "/repo/a.ts", relativePath: "a.ts" }] },
  });
  await indexProject("p1", {}, first.deps);

  const second = harness({
    project: buildProject({ repositories: [{ id: "r1", localPath: "/repo" }] }),
    files: { "/repo": [{ absolutePath: "/repo/a.ts", relativePath: "a.ts" }] },
  });
  for (const [k, v] of first.entries) second.entries.set(k, v);

  const report = await indexProject("p2", {}, second.deps);
  assert.equal(report.skipped, 1);
  assert.equal(report.embedded, 0);
  assert.ok(
    [...second.entries.values()].every((e) => e.projectId === "p2"),
    "the tracking row now names the project that just indexed"
  );
  assert.notEqual(slug, projectSlug("p2"));
});

test("stale chunks for a source are removed before new ones are written", async () => {
  const h = harness({
    project: buildProject({ features: [{ id: "f1", title: "Login" }] }),
  });
  await indexProject("p1", {}, h.deps);
  assert.deepEqual(h.deletedSources, [{ sourceType: "feature", sourceId: "f1" }]);
});

test("written chunks carry the ids and source that identify them", async () => {
  const h = harness({
    project: buildProject({ features: [{ id: "f1", title: "Login" }] }),
  });
  await indexProject("p1", {}, h.deps);
  const record = h.written[0].records[0];
  assert.equal(record.source_type, "feature");
  assert.equal(record.source_id, "f1");
  assert.equal(record.id, "feature:f1:0");
  assert.equal(record.file_path, "feature/f1");
  assert.deepEqual(record.vector, [0.1, 0.2, 0.3]);
  assert.equal(record.updated_at, 1_000);
});

test("repo chunks carry the repo id, project-data chunks do not", async () => {
  const h = harness({
    project: buildProject({
      features: [{ id: "f1", title: "Login" }],
      repositories: [{ id: "r1", localPath: "/repo" }],
    }),
    files: { "/repo": [{ absolutePath: "/repo/a.ts", relativePath: "a.ts" }] },
  });
  await indexProject("p1", {}, h.deps);
  const feature = h.written.find((w) => w.records[0].source_type === "feature");
  const file = h.written.find((w) => w.records[0].source_type === "file");
  assert.equal(feature?.records[0].repo_id, "");
  assert.equal(file?.records[0].repo_id, "r1");
});

// --- corruption recovery ----------------------------------------------------

test("corruption mid-index triggers a full reindex", async () => {
  let opens = 0;
  const h = harness({
    project: buildProject({ features: [{ id: "f1", title: "Login" }] }),
    onOpenStore: () => {
      opens++;
      // Fail once, on the first store the incremental pass opens.
      if (opens === 1) {
        throw new Error(
          "LanceError(IO): Not found: /data/indexes/x/lancedb/data/f.lance"
        );
      }
    },
  });

  const report = await indexProject("p1", {}, h.deps);
  assert.equal(report.embedded, 1);
  // dropProjectIndex ran, then the retry re-dropped as part of mode: "full".
  assert.ok(h.dropped.length >= 2);
});

test("a corrupt run that was already full is not retried", async () => {
  const h = harness({
    project: buildProject(),
    onOpenStore: () => {
      throw new Error("LanceError(IO): Not found: /x/y.lance");
    },
  });
  await assert.rejects(
    () => indexProject("p1", { mode: "full" }, h.deps),
    /LanceError/
  );
});

test("an ordinary failure is not mistaken for corruption", async () => {
  const h = harness({
    project: buildProject(),
    onOpenStore: () => {
      throw new Error("ENOSPC: no space left on device");
    },
  });
  await assert.rejects(() => indexProject("p1", {}, h.deps), /ENOSPC/);
  assert.deepEqual(h.dropped, []);
});

// --- dropProjectIndex -------------------------------------------------------

test("dropping an index clears both per-project stores", async () => {
  const slug = projectSlug("p1");
  const h = harness();
  await dropProjectIndex("p1", h.deps);
  assert.deepEqual(h.dropped, [
    `project-data:${slug}`,
    `conversations:${slug}`,
  ]);
});

test("dropping an index leaves the shared repo store intact", async () => {
  // Repo vectors are shared across projects — only this project's tracking
  // rows may go, or another project would silently lose its index.
  const h = harness();
  await dropProjectIndex("p1", h.deps);
  assert.ok(!h.dropped.some((d) => d.startsWith("repo:")));
  assert.deepEqual(h.deletedEntries, [{ projectId: "p1" }]);
});

// --- searchProject ----------------------------------------------------------

/** A search result from a store: only the fields ranking reads. */
function hit(over: Partial<Hit> = {}): Hit {
  return {
    id: "c1",
    source_type: "file",
    source_id: "s1",
    repo_id: "",
    file_path: "src/app.ts",
    chunk_index: 0,
    start_line: 0,
    end_line: 0,
    heading: "",
    text: "body",
    vector: [],
    updated_at: 0,
    _distance: 0,
    ...over,
  };
}

test("a missing project is reported rather than searched", async () => {
  const h = harness({ repos: null });
  await assert.rejects(
    () => searchProject("p1", "query", {}, h.deps),
    /Project p1 not found/
  );
});

test("the query is embedded once and that vector drives every store", async () => {
  const h = harness({ repos: [{ id: "r1", repoUrl: "https://x/y.git" }] });
  await searchProject("p1", "how does auth work", {}, h.deps);
  assert.deepEqual(h.embedCalls, ["how does auth work"]);
  assert.equal(h.ensureReadyCalls, 1);
  assert.equal(h.searches.length, 3);
  assert.ok(h.searches.every((s) => JSON.stringify(s.vector) === JSON.stringify([0.1, 0.2, 0.3])));
});

test("all three buckets are searched for a project with one repo", async () => {
  const slug = projectSlug("p1");
  const h = harness({ repos: [{ id: "r1", repoUrl: "https://x/y.git" }] });
  await searchProject("p1", "q", {}, h.deps);
  const keys = h.searches.map((s) => s.key).sort();
  assert.deepEqual(keys, [
    `conversations:${slug}`,
    `project-data:${slug}`,
    `repo:${repoKeyFor({ repoUrl: "https://x/y.git" })}`,
  ]);
});

test("a project with no repositories still searches its own buckets", async () => {
  const h = harness({ repos: [] });
  const results = await searchProject("p1", "q", {}, h.deps);
  assert.equal(h.searches.length, 2);
  assert.deepEqual(results.repos, []);
});

test("each repository gets its own store searched", async () => {
  const h = harness({
    repos: [
      { id: "r1", repoUrl: "https://x/one.git" },
      { id: "r2", repoUrl: "https://x/two.git" },
    ],
  });
  await searchProject("p1", "q", {}, h.deps);
  assert.equal(h.searches.filter((s) => s.key.startsWith("repo:")).length, 2);
});

test("hits land in the bucket their store came from", async () => {
  const slug = projectSlug("p1");
  const repoKey = repoKeyFor({ repoUrl: "https://x/y.git" });
  const h = harness({
    repos: [{ id: "r1", repoUrl: "https://x/y.git" }],
    hits: {
      [`project-data:${slug}`]: [hit({ source_id: "feat", source_type: "feature" })],
      [`conversations:${slug}`]: [hit({ source_id: "msg", source_type: "message" })],
      [`repo:${repoKey}`]: [hit({ source_id: "file", source_type: "file" })],
    },
  });
  const results = await searchProject("p1", "q", {}, h.deps);
  assert.deepEqual(results.projectData.map((r) => r.sourceId), ["feat"]);
  assert.deepEqual(results.conversations.map((r) => r.sourceId), ["msg"]);
  assert.deepEqual(results.repos.map((r) => r.sourceId), ["file"]);
  assert.equal(results.projectData[0].bucket, "project-data");
  assert.equal(results.conversations[0].bucket, "conversations");
  assert.equal(results.repos[0].bucket, "repo");
});

test("repo hits are stamped with this project's repo id", async () => {
  // The shared store may have recorded another project's repo id.
  const repoKey = repoKeyFor({ repoUrl: "https://x/y.git" });
  const h = harness({
    repos: [{ id: "mine", repoUrl: "https://x/y.git" }],
    hits: { [`repo:${repoKey}`]: [hit({ repo_id: "someone-elses" })] },
  });
  const results = await searchProject("p1", "q", {}, h.deps);
  assert.deepEqual(results.repos.map((r) => r.repoId), ["mine"]);
});

test("two repos sharing a URL each keep their own id", async () => {
  // repoKeyFor hashes the URL, so both resolve to one store; the hits are
  // paired back to repositories by position, not by what the store recorded.
  const repoKey = repoKeyFor({ repoUrl: "https://x/y.git" });
  const h = harness({
    repos: [
      { id: "r1", repoUrl: "https://x/y.git" },
      { id: "r2", repoUrl: "https://x/y.git" },
    ],
    hits: { [`repo:${repoKey}`]: [hit({ repo_id: "stale" })] },
  });
  const results = await searchProject("p1", "q", {}, h.deps);
  assert.deepEqual(results.repos.map((r) => r.repoId).sort(), ["r1", "r2"]);
});

test("results are ordered by nearness within each bucket", async () => {
  const slug = projectSlug("p1");
  const h = harness({
    repos: [],
    hits: {
      [`project-data:${slug}`]: [
        hit({ source_id: "far", _distance: 9 }),
        hit({ source_id: "near", _distance: 0.1 }),
        hit({ source_id: "mid", _distance: 1 }),
      ],
    },
  });
  const results = await searchProject("p1", "q", {}, h.deps);
  assert.deepEqual(results.projectData.map((r) => r.sourceId), [
    "near",
    "mid",
    "far",
  ]);
});

test("hits from several repos are merged and ranked together", async () => {
  const keyOne = repoKeyFor({ repoUrl: "https://x/one.git" });
  const keyTwo = repoKeyFor({ repoUrl: "https://x/two.git" });
  const h = harness({
    repos: [
      { id: "r1", repoUrl: "https://x/one.git" },
      { id: "r2", repoUrl: "https://x/two.git" },
    ],
    hits: {
      [`repo:${keyOne}`]: [hit({ source_id: "from-one", _distance: 5 })],
      [`repo:${keyTwo}`]: [hit({ source_id: "from-two", _distance: 0.2 })],
    },
  });
  const results = await searchProject("p1", "q", {}, h.deps);
  assert.deepEqual(results.repos.map((r) => r.sourceId), ["from-two", "from-one"]);
});

test("k defaults to 8 and is passed to every store", async () => {
  const h = harness({ repos: [{ id: "r1", repoUrl: "https://x/y.git" }] });
  await searchProject("p1", "q", {}, h.deps);
  assert.ok(h.searches.every((s) => s.k === 8));
});

test("a caller's k reaches the stores and caps each bucket", async () => {
  const slug = projectSlug("p1");
  const h = harness({
    repos: [],
    hits: {
      [`project-data:${slug}`]: Array.from({ length: 5 }, (_, i) =>
        hit({ source_id: `s${i}`, _distance: i })
      ),
    },
  });
  const results = await searchProject("p1", "q", { k: 2 }, h.deps);
  assert.ok(h.searches.every((s) => s.k === 2));
  assert.equal(results.projectData.length, 2);
});

test("k caps each bucket independently, not the total", async () => {
  const slug = projectSlug("p1");
  const h = harness({
    repos: [],
    hits: {
      [`project-data:${slug}`]: [hit({ source_id: "a" }), hit({ source_id: "b" })],
      [`conversations:${slug}`]: [hit({ source_id: "c" }), hit({ source_id: "d" })],
    },
  });
  const results = await searchProject("p1", "q", { k: 2 }, h.deps);
  assert.equal(results.projectData.length, 2);
  assert.equal(results.conversations.length, 2);
});

test("a sourceTypes filter is pushed down to every store", async () => {
  const h = harness({ repos: [{ id: "r1", repoUrl: "https://x/y.git" }] });
  await searchProject("p1", "q", { sourceTypes: ["file", "feature"] }, h.deps);
  assert.ok(
    h.searches.every(
      (s) => JSON.stringify(s.filters?.sourceTypes) === JSON.stringify(["file", "feature"])
    )
  );
});

test("repoIds narrows the returned repos", async () => {
  const keyOne = repoKeyFor({ repoUrl: "https://x/one.git" });
  const keyTwo = repoKeyFor({ repoUrl: "https://x/two.git" });
  const h = harness({
    repos: [
      { id: "r1", repoUrl: "https://x/one.git" },
      { id: "r2", repoUrl: "https://x/two.git" },
    ],
    hits: {
      [`repo:${keyOne}`]: [hit({ source_id: "keep" })],
      [`repo:${keyTwo}`]: [hit({ source_id: "drop" })],
    },
  });
  const results = await searchProject("p1", "q", { repoIds: ["r1"] }, h.deps);
  assert.deepEqual(results.repos.map((r) => r.sourceId), ["keep"]);
});

test("repoIds does not narrow the non-repo buckets", async () => {
  const slug = projectSlug("p1");
  const h = harness({
    repos: [{ id: "r1", repoUrl: "https://x/y.git" }],
    hits: { [`project-data:${slug}`]: [hit({ source_id: "feat" })] },
  });
  const results = await searchProject("p1", "q", { repoIds: ["r1"] }, h.deps);
  assert.deepEqual(results.projectData.map((r) => r.sourceId), ["feat"]);
});

test("the provider decides the dimensions every store is opened with", async () => {
  // A store opened at the wrong width cannot match the query vector.
  const nomic = harness({ repos: [{ id: "r1", repoUrl: "https://x/y.git" }] });
  await searchProject("p1", "q", {}, nomic.deps);
  assert.deepEqual(nomic.openedDimensions, [768, 768, 768]);

  const openai = harness({ repos: [] });
  await searchProject("p1", "q", { provider: "openai-3-small" }, openai.deps);
  assert.deepEqual(openai.openedDimensions, [1536, 1536]);
});

test("empty stores yield empty buckets, not an error", async () => {
  const h = harness({ repos: [{ id: "r1", repoUrl: "https://x/y.git" }] });
  const results = await searchProject("p1", "q", {}, h.deps);
  assert.deepEqual(results, { repos: [], conversations: [], projectData: [] });
});
