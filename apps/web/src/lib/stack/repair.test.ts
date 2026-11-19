import { strict as assert } from "node:assert";
import { test } from "node:test";

import { describePatch, reviewRepairs, weakensTheCheck } from "./repair";
import type { StackSuggestion } from "./types";

function ctx(
  over: {
    nodes?: Record<string, { localCommand?: string | null; ports?: unknown }>;
    seeded?: string[];
  } = {},
) {
  const nodes = new Map(Object.entries(over.nodes ?? { n1: { localCommand: "pnpm dev", ports: [{ host: 3000, container: 3000 }] } }));
  return {
    nodes,
    seeded: new Set(over.seeded ?? [...nodes.keys()]),
  };
}

const patch = (over: Partial<StackSuggestion> = {}): StackSuggestion => ({
  nodeId: "n1",
  patch: { installCommand: "pnpm install && pnpm prisma generate" },
  reason: "the build cannot find the generated client",
  ...over,
});

test("a genuine fix is accepted", () => {
  const { accepted, rejected } = reviewRepairs([patch()], ctx());
  assert.equal(accepted.length, 1);
  assert.deepEqual(rejected, []);
});

test("removing the run command is refused", () => {
  // The failure this whole applier exists for: an agent asked to make
  // validation pass can make it pass by removing what was failing.
  const { accepted, rejected } = reviewRepairs(
    [patch({ patch: { localCommand: null } })],
    ctx(),
  );
  assert.equal(accepted.length, 0);
  assert.match(rejected[0].reason, /stop being started/);
});

test("removing the port is refused", () => {
  // Without a port the boot probe is skipped, which reads as success.
  const { accepted, rejected } = reviewRepairs(
    [patch({ patch: { ports: [] } })],
    ctx(),
  );
  assert.equal(accepted.length, 0);
  assert.match(rejected[0].reason, /boot probe waits on/);
});

test("an empty string counts as removing the command", () => {
  const { rejected } = reviewRepairs(
    [patch({ patch: { localCommand: "   " } })],
    ctx(),
  );
  assert.equal(rejected.length, 1);
});

test("blanking a field that was already blank is not a weakening", () => {
  // It changes nothing, so refusing it would be a confusing report about a
  // no-op rather than a protection.
  const { accepted } = reviewRepairs(
    [patch({ patch: { localCommand: null } })],
    ctx({ nodes: { n1: { localCommand: null, ports: [] } } }),
  );
  assert.equal(accepted.length, 1);
});

test("changing a run command to a different one is fine", () => {
  // The rule is about removal, not about editing.
  const { accepted } = reviewRepairs(
    [patch({ patch: { localCommand: "pnpm start" } })],
    ctx(),
  );
  assert.equal(accepted.length, 1);
});

test("a node the user edited is never touched", () => {
  // Only ids the seed created may be patched; everything else is a hand edit,
  // and an agent silently rewriting one is the worst outcome available here.
  const { accepted, rejected } = reviewRepairs([patch()], ctx({ seeded: [] }));
  assert.equal(accepted.length, 0);
  assert.match(rejected[0].reason, /edited by hand/);
});

test("creating a service is refused", () => {
  // A repair fixes how the project runs. Adding a service the project never
  // asked for is a guess with a container attached — inference belongs to the
  // seed, where it is driven by the repos' own evidence.
  const { accepted, rejected } = reviewRepairs(
    [patch({ nodeId: undefined, createService: { catalogKey: "redis" } })],
    ctx(),
  );
  assert.equal(accepted.length, 0);
  assert.match(rejected[0].reason, /may not add services/);
});

test("a hallucinated node id is refused", () => {
  // The ordinary failure of a model reading a truncated tool result.
  const { rejected } = reviewRepairs([patch({ nodeId: "nope" })], ctx());
  assert.match(rejected[0].reason, /no node nope/);
});

test("a suggestion targeting a repository rather than a node is refused", () => {
  // It would create a node, which is rule 2 by another route.
  const { rejected } = reviewRepairs(
    [patch({ nodeId: undefined, repositoryId: "r1" })],
    ctx(),
  );
  assert.match(rejected[0].reason, /existing node, by id/);
});

test("an empty patch is refused rather than applied", () => {
  const { rejected } = reviewRepairs([patch({ patch: {} })], ctx());
  assert.match(rejected[0].reason, /no change proposed/);
});

test("good and bad suggestions in one reply are separated", () => {
  // A round is not all-or-nothing: the fix lands and the weakening does not.
  const { accepted, rejected } = reviewRepairs(
    [
      patch({ patch: { installCommand: "pnpm install --frozen-lockfile" } }),
      patch({ patch: { ports: null } }),
    ],
    ctx(),
  );
  assert.equal(accepted.length, 1);
  assert.equal(rejected.length, 1);
});

test("weakensTheCheck names the field it is protecting", () => {
  assert.equal(weakensTheCheck({ installCommand: "x" }, { localCommand: "pnpm dev" }), null);
  assert.match(
    weakensTheCheck({ localCommand: "" }, { localCommand: "pnpm dev" })!,
    /run command/,
  );
  assert.equal(weakensTheCheck(undefined, null), null);
});

test("describePatch is readable enough to review a round by", () => {
  // The safety story is that nothing happens silently, so the diff has to be
  // legible without opening the database.
  assert.equal(
    describePatch({ installCommand: "pnpm install", ports: [{ host: 1, container: 1 }] }),
    "installCommand: pnpm install, ports: 1:1",
  );
  // The values, not a count: a reviewer who has to open the node to see what
  // changed is doing the review this line exists to save them.
  assert.equal(
    describePatch({ ports: [{ host: 3001, container: 3000 }] }),
    "ports: 3001:3000",
  );
  assert.equal(
    describePatch({ env: [{ key: "PORT", value: "3001" }] }),
    "env: PORT=3001",
  );
  assert.match(
    describePatch({ ports: [1, 2, 3, 4].map((n) => ({ host: n, container: n })) }),
    /\+1 more$/,
  );
  // An emptied array reads as what it is, not as "0 entries".
  assert.equal(describePatch({ ports: [] }), "ports: cleared");
  assert.match(describePatch({ localCommand: null }), /cleared/);
});
