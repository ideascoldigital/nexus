import assert from "node:assert/strict";
import fs from "node:fs";
import { after, test } from "node:test";

// Env setup must stay above the service imports — roadmap-generator reaches
// @nexux/db, whose client is built at module load.
import { testDbDir } from "./services.test-setup";
import {
  composeAiRefinement,
  extractJsonBlock,
  proposedFeatureSchema,
  roadmapProposalSchema,
  sanitizeKeys,
  type RoadmapProposal,
} from "./roadmap-generator";

after(() => {
  fs.rmSync(testDbDir, { recursive: true, force: true });
});

// --- extractJsonBlock -------------------------------------------------------

test("a fenced json block is parsed", () => {
  const parsed = extractJsonBlock('prose\n```json\n{"phases":[]}\n```');
  assert.deepEqual(parsed, { phases: [] });
});

test("a bare json object is parsed when there is no fence", () => {
  assert.deepEqual(extractJsonBlock('text {"a":1} more'), { a: 1 });
});

test("a fenced block wins over surrounding braces", () => {
  // The prose may itself contain braces; the fence is the reliable signal.
  const parsed = extractJsonBlock('{"decoy":1}\n```json\n{"real":2}\n```');
  assert.deepEqual(parsed, { real: 2 });
});

test("a response with no json yields null", () => {
  assert.equal(extractJsonBlock("just prose, no payload"), null);
  assert.equal(extractJsonBlock(""), null);
});

test("malformed json yields null instead of throwing", () => {
  assert.equal(extractJsonBlock("```json\n{not json}\n```"), null);
  assert.equal(extractJsonBlock('{"unterminated": '), null);
});

test("a multi-line object spanning the whole reply is parsed", () => {
  const parsed = extractJsonBlock(
    'Here you go:\n{\n  "phases": [\n    { "name": "MVP" }\n  ]\n}'
  );
  assert.deepEqual(parsed, { phases: [{ name: "MVP" }] });
});

// --- proposal schema --------------------------------------------------------

test("a minimal feature gets its optional fields defaulted", () => {
  const feature = proposedFeatureSchema.parse({ title: "Login" });
  assert.equal(feature.description, "");
  assert.equal(feature.priority, "medium");
  assert.deepEqual(feature.acceptanceCriteria, []);
  assert.deepEqual(feature.sourceSectionKeys, []);
});

test("a feature without a title is rejected", () => {
  assert.equal(proposedFeatureSchema.safeParse({}).success, false);
  assert.equal(proposedFeatureSchema.safeParse({ title: "" }).success, false);
});

test("only the four known priorities are accepted", () => {
  for (const priority of ["low", "medium", "high", "urgent"]) {
    assert.equal(
      proposedFeatureSchema.safeParse({ title: "t", priority }).success,
      true,
      priority
    );
  }
  assert.equal(
    proposedFeatureSchema.safeParse({ title: "t", priority: "critical" }).success,
    false
  );
});

test("a proposal needs at least one phase", () => {
  assert.equal(roadmapProposalSchema.safeParse({ phases: [] }).success, false);
  assert.equal(
    roadmapProposalSchema.safeParse({ phases: [{ name: "MVP" }] }).success,
    true
  );
});

test("a phase order must be a non-negative integer", () => {
  const ok = roadmapProposalSchema.safeParse({
    phases: [{ name: "MVP", order: 0 }],
  });
  assert.equal(ok.success, true);
  assert.equal(
    roadmapProposalSchema.safeParse({ phases: [{ name: "MVP", order: -1 }] })
      .success,
    false
  );
  assert.equal(
    roadmapProposalSchema.safeParse({ phases: [{ name: "MVP", order: 1.5 }] })
      .success,
    false
  );
});

test("a phase defaults to order zero with no features", () => {
  const proposal = roadmapProposalSchema.parse({ phases: [{ name: "MVP" }] });
  assert.equal(proposal.phases[0].order, 0);
  assert.equal(proposal.phases[0].goal, "");
  assert.deepEqual(proposal.phases[0].features, []);
});

test("features nested in a phase are validated too", () => {
  const bad = roadmapProposalSchema.safeParse({
    phases: [{ name: "MVP", features: [{ description: "no title" }] }],
  });
  assert.equal(bad.success, false);
});

// --- sanitizeKeys -----------------------------------------------------------

const proposal = (
  phaseKeys: string[],
  featureKeys: string[]
): RoadmapProposal => ({
  phases: [
    {
      name: "MVP",
      goal: "",
      order: 0,
      sourceSectionKeys: phaseKeys,
      features: [
        {
          title: "Login",
          description: "",
          priority: "medium",
          acceptanceCriteria: [],
          sourceSectionKeys: featureKeys,
        },
      ],
    },
  ],
});

test("known section keys survive sanitizing", () => {
  const out = sanitizeKeys(proposal(["a"], ["b"]), new Set(["a", "b"]));
  assert.deepEqual(out.phases[0].sourceSectionKeys, ["a"]);
  assert.deepEqual(out.phases[0].features[0].sourceSectionKeys, ["b"]);
});

test("hallucinated keys are dropped, not rejected", () => {
  // The model cites sections that do not exist; the proposal is still usable.
  const out = sanitizeKeys(
    proposal(["real", "invented"], ["also-invented"]),
    new Set(["real"])
  );
  assert.deepEqual(out.phases[0].sourceSectionKeys, ["real"]);
  assert.deepEqual(out.phases[0].features[0].sourceSectionKeys, []);
});

test("no valid keys leaves empty citations rather than dropping the phase", () => {
  const out = sanitizeKeys(proposal(["x"], ["y"]), new Set());
  assert.equal(out.phases.length, 1);
  assert.deepEqual(out.phases[0].sourceSectionKeys, []);
});

test("sanitizing keeps everything else about the proposal", () => {
  const out = sanitizeKeys(proposal(["a"], ["a"]), new Set(["a"]));
  assert.equal(out.phases[0].name, "MVP");
  assert.equal(out.phases[0].features[0].title, "Login");
  assert.equal(out.phases[0].features[0].priority, "medium");
});

test("sanitizing does not mutate the input proposal", () => {
  const input = proposal(["a", "bogus"], []);
  sanitizeKeys(input, new Set(["a"]));
  assert.deepEqual(input.phases[0].sourceSectionKeys, ["a", "bogus"]);
});

// --- composeAiRefinement ----------------------------------------------------

test("nothing to record produces no refinement", () => {
  assert.equal(composeAiRefinement([], [], {}), null);
});

test("acceptance criteria are rendered as a bullet list", () => {
  const out = composeAiRefinement(["works", "is tested"], [], {});
  assert.equal(out, "## Acceptance criteria\n- works\n- is tested");
});

test("source sections cite their title and key", () => {
  const out = composeAiRefinement([], ["k1"], { k1: "Overview" });
  assert.equal(out, "## Source: definition sections\n- Overview (k1)");
});

test("a key with no known title falls back to the key itself", () => {
  const out = composeAiRefinement([], ["orphan"], {});
  assert.match(out ?? "", /- orphan \(orphan\)/);
});

test("both sections appear in order when both are present", () => {
  const out = composeAiRefinement(["works"], ["k1"], { k1: "Overview" });
  assert.equal(
    out,
    "## Acceptance criteria\n- works\n\n## Source: definition sections\n- Overview (k1)"
  );
});
