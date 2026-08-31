import assert from "node:assert/strict";
import fs from "node:fs";
import { after, test } from "node:test";

// Env setup must stay above the service imports — the module graph reaches
// @nexux/db, whose client is built at module load.
import { testDbDir } from "./services.test-setup";
import {
  parseSectionUpdates,
  resolveFinalRole,
  runDefinerTurn,
  type DefinerTurnDeps,
} from "./project-definer-agents";
import type { TransferEvent } from "./agent-deps";

after(() => {
  fs.rmSync(testDbDir, { recursive: true, force: true });
});

const sectionBlock = (updates: unknown) =>
  `\`\`\`json\n${JSON.stringify({ sectionUpdates: updates })}\n\`\`\``;

type Recorded = { prompts: string[]; histories: unknown[] };

function deps(opts: {
  reply?: string;
  transfers?: TransferEvent[];
}): { deps: DefinerTurnDeps; rec: Recorded } {
  const rec: Recorded = { prompts: [], histories: [] };
  return {
    rec,
    deps: {
      buildTriage: async () => ({
        run: async (input, runOpts) => {
          rec.prompts.push(input);
          rec.histories.push(runOpts?.history);
          return { message: opts.reply ?? "a reply", transfers: opts.transfers };
        },
      }),
    },
  };
}

// --- resolveFinalRole -------------------------------------------------------

test("no handoff means the project manager answered", () => {
  // Triage is told to always hand off; if it did not, PM is the safe default.
  assert.equal(resolveFinalRole(undefined), "project-manager");
  assert.equal(resolveFinalRole([]), "project-manager");
});

test("a single handoff names the specialist that replied", () => {
  assert.equal(
    resolveFinalRole([{ to_agent: "definer-finance-manager" }]),
    "finance-manager"
  );
});

test("every specialist is recognized by its agent name", () => {
  const pairs: [string, string][] = [
    ["definer-project-manager", "project-manager"],
    ["definer-finance-manager", "finance-manager"],
    ["definer-technical-architect", "technical-architect"],
    ["definer-product-ux", "product-ux"],
    ["definer-detractor", "detractor"],
  ];
  for (const [name, role] of pairs) {
    assert.equal(resolveFinalRole([{ to_agent: name }]), role, name);
  }
});

test("the last handoff wins when the turn was routed more than once", () => {
  // Transfers arrive in order; the final destination produced the message.
  assert.equal(
    resolveFinalRole([
      { to_agent: "definer-project-manager" },
      { to_agent: "definer-detractor" },
    ]),
    "detractor"
  );
});

test("an unrecognized destination is skipped in favour of an earlier one", () => {
  assert.equal(
    resolveFinalRole([
      { to_agent: "definer-finance-manager" },
      { to_agent: "definer-unknown-specialist" },
    ]),
    "finance-manager"
  );
});

test("handoffs with no usable destination fall back to the project manager", () => {
  assert.equal(resolveFinalRole([{ from_agent: "definer-triage" }]), "project-manager");
  assert.equal(resolveFinalRole([{ to_agent: "nobody" }]), "project-manager");
});

// --- parseSectionUpdates ----------------------------------------------------

test("a reply with no json block persists nothing", () => {
  assert.deepEqual(parseSectionUpdates("Just prose about scope."), []);
  assert.deepEqual(parseSectionUpdates(""), []);
});

test("section updates are read from the fenced block", () => {
  const updates = parseSectionUpdates(
    `Here is the scope.\n${sectionBlock([
      { key: "scope-in", content: "- A\n- B", status: "draft" },
    ])}`
  );
  assert.deepEqual(updates, [
    { key: "scope-in", content: "- A\n- B", status: "draft" },
  ]);
});

test("several sections in one reply are all kept", () => {
  const updates = parseSectionUpdates(
    sectionBlock([
      { key: "overview", content: "text" },
      { key: "budget", content: "numbers" },
    ])
  );
  assert.deepEqual(
    updates.map((u) => u.key),
    ["overview", "budget"]
  );
});

test("status defaults to draft when absent or unknown", () => {
  // Only the model explicitly saying "approved" may skip review.
  const updates = parseSectionUpdates(
    sectionBlock([
      { key: "a", content: "x" },
      { key: "b", content: "x", status: "final" },
      { key: "c", content: "x", status: "approved" },
    ])
  );
  assert.deepEqual(
    updates.map((u) => u.status),
    ["draft", "draft", "approved"]
  );
});

test("entries without a string key and content are dropped", () => {
  const updates = parseSectionUpdates(
    sectionBlock([
      { key: "keep", content: "body" },
      { key: "no-content" },
      { content: "no-key" },
      { key: 7, content: "numeric key" },
      null,
    ])
  );
  assert.deepEqual(updates, [
    { key: "keep", content: "body", status: "draft" },
  ]);
});

test("a json block that is not a sectionUpdates payload persists nothing", () => {
  assert.deepEqual(parseSectionUpdates('```json\n{"other":[1,2]}\n```'), []);
  assert.deepEqual(parseSectionUpdates('```json\n{"sectionUpdates":"nope"}\n```'), []);
});

test("malformed json persists nothing rather than throwing", () => {
  assert.deepEqual(parseSectionUpdates("```json\n{broken\n```"), []);
});

test("an empty update list is valid and persists nothing", () => {
  assert.deepEqual(parseSectionUpdates(sectionBlock([])), []);
});

// --- runDefinerTurn ---------------------------------------------------------

test("the user's message and history reach the triage agent", async () => {
  const history = [{ role: "user" as const, content: "earlier" }];
  const { deps: d, rec } = deps({});
  await runDefinerTurn("what is the budget?", history, d);
  assert.deepEqual(rec.prompts, ["what is the budget?"]);
  assert.deepEqual(rec.histories[0], history);
});

test("the turn reports which specialist answered", async () => {
  const { deps: d } = deps({
    reply: "Budget breakdown follows.",
    transfers: [{ from_agent: "definer-triage", to_agent: "definer-finance-manager" }],
  });
  const turn = await runDefinerTurn("q", [], d);
  assert.equal(turn.finalRole, "finance-manager");
  assert.equal(turn.finalMessage, "Budget breakdown follows.");
});

test("transfers are renamed to the shape the client stores", async () => {
  const { deps: d } = deps({
    transfers: [
      { from_agent: "definer-triage", to_agent: "definer-detractor", reason: "stress test" },
    ],
  });
  const turn = await runDefinerTurn("q", [], d);
  assert.deepEqual(turn.transfers, [
    { from: "definer-triage", to: "definer-detractor", reason: "stress test" },
  ]);
});

test("a turn with no handoff still reports an empty transfer list", async () => {
  const { deps: d } = deps({ reply: "answer" });
  const turn = await runDefinerTurn("q", [], d);
  assert.deepEqual(turn.transfers, []);
  assert.equal(turn.finalRole, "project-manager");
});

test("section updates are parsed from the specialist's reply", async () => {
  const { deps: d } = deps({
    reply: `Scope set.\n${sectionBlock([{ key: "scope-in", content: "- A" }])}`,
    transfers: [{ to_agent: "definer-project-manager" }],
  });
  const turn = await runDefinerTurn("q", [], d);
  assert.deepEqual(turn.sectionUpdates, [
    { key: "scope-in", content: "- A", status: "draft" },
  ]);
});

test("the final message keeps the block the client re-reads", async () => {
  // Unlike the feature assistant, the definer stores the reply whole.
  const reply = `Scope set.\n${sectionBlock([{ key: "scope-in", content: "- A" }])}`;
  const { deps: d } = deps({ reply });
  const turn = await runDefinerTurn("q", [], d);
  assert.equal(turn.finalMessage, reply);
});

test("an empty agent reply yields an empty turn rather than throwing", async () => {
  const { deps: d } = deps({ reply: "" });
  const turn = await runDefinerTurn("q", [], d);
  assert.equal(turn.finalMessage, "");
  assert.deepEqual(turn.sectionUpdates, []);
  assert.equal(turn.finalRole, "project-manager");
});
