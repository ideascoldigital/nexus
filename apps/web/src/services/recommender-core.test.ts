import assert from "node:assert/strict";
import { test } from "node:test";

// recommender-core is free of prisma, the filesystem and the agent client,
// so it needs no env setup.
import {
  buildProfile,
  buildRecommenderMessage,
  catalogCandidates,
  depsFromPackageJson,
  formatCandidate,
  keywordsForDeps,
  parseRecommendations,
  renderDefinition,
  type Candidate,
} from "./recommender-core";

// --- depsFromPackageJson ----------------------------------------------------

test("dependencies and devDependencies are both collected", () => {
  const deps = depsFromPackageJson(
    JSON.stringify({
      dependencies: { react: "19", next: "16" },
      devDependencies: { vitest: "3" },
    })
  );
  assert.deepEqual(deps, ["react", "next", "vitest"]);
});

test("a package.json with no dependency blocks yields nothing", () => {
  assert.deepEqual(depsFromPackageJson('{"name":"app"}'), []);
});

test("malformed package.json yields nothing rather than throwing", () => {
  assert.deepEqual(depsFromPackageJson("{ not json"), []);
  assert.deepEqual(depsFromPackageJson(""), []);
});

test("the dependency list is capped so it cannot flood the prompt", () => {
  const many = Object.fromEntries(
    Array.from({ length: 60 }, (_, i) => [`dep-${i}`, "1"])
  );
  assert.equal(depsFromPackageJson(JSON.stringify({ dependencies: many })).length, 40);
});

// --- renderDefinition -------------------------------------------------------

test("no sections render to an empty definition", () => {
  assert.equal(renderDefinition([]), "");
});

test("a section is rendered as title and body", () => {
  assert.equal(
    renderDefinition([{ title: "Overview", content: "We build things." }]),
    "Overview: We build things."
  );
});

test("whitespace inside a section is collapsed", () => {
  // Raw markdown carries newlines that would break the profile's structure.
  assert.equal(
    renderDefinition([{ title: "T", content: "a\n\n   b\tc" }]),
    "T: a b c"
  );
});

test("a section with no content still names itself", () => {
  assert.equal(renderDefinition([{ title: "Budget", content: null }]), "Budget: ");
});

test("a long section is clipped", () => {
  const rendered = renderDefinition([{ title: "T", content: "x".repeat(500) }]);
  assert.equal(rendered.length, "T: ".length + 220);
});

test("the whole definition is clipped even across many sections", () => {
  const sections = Array.from({ length: 20 }, (_, i) => ({
    title: `T${i}`,
    content: "y".repeat(300),
  }));
  assert.equal(renderDefinition(sections).length, 1800);
});

// --- buildProfile -----------------------------------------------------------

const bareProject = { name: "Nexus", description: null, stackNodes: [] };

test("a bare project profiles as just its name", () => {
  assert.equal(buildProfile(bareProject, "", []), "Project: Nexus");
});

test("empty parts are omitted rather than left blank", () => {
  // A blank "Description:" line would waste prompt space and read as noise.
  const profile = buildProfile({ ...bareProject, description: "" }, "", []);
  assert.doesNotMatch(profile, /Description/);
  assert.doesNotMatch(profile, /Definition/);
  assert.doesNotMatch(profile, /Dependencies/);
  assert.doesNotMatch(profile, /Infra services/);
});

test("every populated part is labelled in the profile", () => {
  const profile = buildProfile(
    { name: "Nexus", description: "A dev orchestrator", stackNodes: [{ name: "db" }] },
    "Overview: something",
    ["- web: react, next"]
  );
  assert.match(profile, /Project: Nexus/);
  assert.match(profile, /Description: A dev orchestrator/);
  assert.match(profile, /Definition:\nOverview: something/);
  assert.match(profile, /Dependencies:\n- web: react, next/);
  assert.match(profile, /Infra services: db/);
});

test("several infra services are listed together", () => {
  const profile = buildProfile(
    { ...bareProject, stackNodes: [{ name: "db" }, { name: "redis" }] },
    "",
    []
  );
  assert.match(profile, /Infra services: db, redis/);
});

test("profile parts are separated by blank lines", () => {
  const profile = buildProfile({ ...bareProject, description: "d" }, "", []);
  assert.equal(profile, "Project: Nexus\n\nDescription: d");
});

// --- keywordsForDeps --------------------------------------------------------

test("no dependencies imply no registry queries", () => {
  assert.deepEqual(keywordsForDeps([]), []);
});

test("a known framework is picked up exactly", () => {
  assert.deepEqual(keywordsForDeps(["react"]), ["react"]);
});

test("a scoped or suffixed dependency still matches its framework", () => {
  // `next-auth` and `@types/react` should both imply their framework.
  assert.deepEqual(keywordsForDeps(["next-auth"]), ["next"]);
  assert.ok(keywordsForDeps(["@types/react"]).includes("react"));
});

test("an unrelated dependency implies nothing", () => {
  assert.deepEqual(keywordsForDeps(["lodash", "chalk"]), []);
});

test("at most three queries are produced", () => {
  // Each keyword costs a registry round-trip.
  const deps = ["react", "next", "vue", "prisma", "stripe", "jest"];
  assert.equal(keywordsForDeps(deps).length, 3);
});

test("keywords follow the catalog's order, not the project's", () => {
  assert.deepEqual(keywordsForDeps(["prisma", "react"]), ["react", "prisma"]);
});

// --- catalogCandidates ------------------------------------------------------

test("an empty catalog yields no candidates", () => {
  assert.deepEqual(catalogCandidates([], new Set()), []);
});

test("a catalog entry becomes a candidate", () => {
  assert.deepEqual(
    catalogCandidates([{ id: "s1", name: "Deploy", description: "How to ship" }], new Set()),
    [{ source: "catalog", id: "s1", name: "Deploy", description: "How to ship" }]
  );
});

test("an already-attached entry is marked so the model skips it", () => {
  const [candidate] = catalogCandidates(
    [{ id: "s1", name: "Deploy" }],
    new Set(["s1"])
  );
  assert.equal(candidate.name, "Deploy [attached]");
});

test("only the attached entries are marked", () => {
  const candidates = catalogCandidates(
    [
      { id: "s1", name: "A" },
      { id: "s2", name: "B" },
    ],
    new Set(["s2"])
  );
  assert.deepEqual(
    candidates.map((c) => c.name),
    ["A", "B [attached]"]
  );
});

test("a missing description becomes empty, and a long one is clipped", () => {
  const [none] = catalogCandidates([{ id: "s1", name: "A" }], new Set());
  assert.equal(none.description, "");
  const [long] = catalogCandidates(
    [{ id: "s2", name: "B", description: "x".repeat(400) }],
    new Set()
  );
  assert.equal(long.description.length, 160);
});

// --- formatCandidate / buildRecommenderMessage ------------------------------

const candidate = (over: Partial<Candidate> = {}): Candidate => ({
  source: "catalog",
  id: "s1",
  name: "Deploy",
  description: "How to ship",
  ...over,
});

test("a candidate line carries its pool, id and name", () => {
  assert.equal(
    formatCandidate(candidate()),
    "- [catalog] id=s1 Deploy — How to ship"
  );
});

test("a candidate with no description omits the dash", () => {
  assert.equal(
    formatCandidate(candidate({ description: "" })),
    "- [catalog] id=s1 Deploy"
  );
});

test("both pools are labelled in the message", () => {
  const message = buildRecommenderMessage(
    "Project: Nexus",
    [candidate()],
    [candidate({ source: "registry", id: "r1", name: "Registry skill" })]
  );
  assert.match(message, /PROJECT PROFILE:\nProject: Nexus/);
  assert.match(message, /CATALOG:\n- \[catalog\] id=s1 Deploy/);
  assert.match(message, /REGISTRY:\n- \[registry\] id=r1 Registry skill/);
});

test("an empty pool is spelled out rather than left blank", () => {
  // A blank section would read as a truncated prompt to the model.
  const message = buildRecommenderMessage("p", [], []);
  assert.match(message, /CATALOG:\n\(empty\)/);
  assert.match(message, /REGISTRY:\n\(empty\)/);
});

// --- parseRecommendations ---------------------------------------------------

const block = (recommendations: unknown) =>
  `\`\`\`json\n${JSON.stringify({ recommendations })}\n\`\`\``;

test("recommendations are read from the fenced block", () => {
  const parsed = parseRecommendations(
    block([{ source: "catalog", id: "s1", name: "Deploy", reason: "uses docker" }]),
    6
  );
  assert.deepEqual(parsed, [
    { source: "catalog", id: "s1", name: "Deploy", reason: "uses docker" },
  ]);
});

test("a bare json reply is accepted when the model skips the fence", () => {
  const parsed = parseRecommendations(
    '{"recommendations":[{"source":"registry","id":"r1","name":"A","reason":"r"}]}',
    6
  );
  assert.equal(parsed.length, 1);
});

test("an unparseable answer is surfaced as a retry, not as silence", () => {
  // Returning [] here would look like "no skills fit this project".
  assert.throws(
    () => parseRecommendations("I could not decide.", 6),
    /unparseable answer/
  );
  assert.throws(() => parseRecommendations("```json\n{broken\n```", 6), /unparseable/);
});

test("a well-formed reply with no recommendations is empty, not an error", () => {
  assert.deepEqual(parseRecommendations(block([]), 6), []);
  assert.deepEqual(parseRecommendations('{"other":1}', 6), []);
});

test("entries from an unknown pool are dropped", () => {
  // Only catalog and registry can be acted on by the UI.
  const parsed = parseRecommendations(
    block([
      { source: "invented", id: "x", name: "X", reason: "r" },
      { source: "catalog", id: "s1", name: "Keep", reason: "r" },
    ]),
    6
  );
  assert.deepEqual(
    parsed.map((r) => r.name),
    ["Keep"]
  );
});

test("entries without a string id and name are dropped", () => {
  const parsed = parseRecommendations(
    block([
      { source: "catalog", id: 1, name: "numeric id", reason: "r" },
      { source: "catalog", id: "s1", reason: "no name" },
      { source: "catalog", id: "s2", name: "Keep", reason: "r" },
    ]),
    6
  );
  assert.deepEqual(
    parsed.map((r) => r.name),
    ["Keep"]
  );
});

test("the attached marker is stripped from the recommended name", () => {
  // The model sees "Deploy [attached]" in the pool and may echo it back; the
  // name has to match the real catalog entry again.
  const parsed = parseRecommendations(
    block([{ source: "catalog", id: "s1", name: "Deploy [attached]", reason: "r" }]),
    6
  );
  assert.equal(parsed[0].name, "Deploy");
});

test("the caller's limit caps how many recommendations come back", () => {
  const many = Array.from({ length: 9 }, (_, i) => ({
    source: "catalog" as const,
    id: `s${i}`,
    name: `N${i}`,
    reason: "r",
  }));
  assert.equal(parseRecommendations(block(many), 6).length, 6);
  assert.equal(parseRecommendations(block(many), 5).length, 5);
});
