import "./services.test-setup";

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { MAX_REPAIR_ROUNDS, repairProjectStack } from "./stack-repair";
import type { StackValidation } from "@/lib/stack/types";

/** A validation result: clean unless told otherwise. */
function validation(over: Partial<StackValidation> = {}): StackValidation {
  return { ok: true, findings: [], observed: null, ...over };
}

/** A validation that failed on a boot probe, with the tail that explains it. */
function bootFailure(tail = "Error: Cannot find module '@/generated/prisma'") {
  return validation({
    ok: true,
    observed: {
      sandboxId: "s1",
      sandboxName: "box",
      sandboxStatus: "running",
      provisionedAt: "2026-09-23T00:00:00Z",
      steps: [],
      failed: [
        { step: "boot:api", severity: "warn", exitCode: 1, durationMs: 180_000, at: "", tail },
      ],
      booted: false,
    },
  });
}

const suggestion = (over: Record<string, unknown> = {}) => ({
  nodeId: "n1",
  patch: { installCommand: "pnpm install && pnpm prisma generate" },
  reason: "the generated client is missing",
  ...over,
});

/** Stubs for everything the loop reaches outside itself. */
function harness(opts: {
  validations: StackValidation[];
  suggestions?: Array<Array<Record<string, unknown>>>;
}) {
  const applied: Array<{ nodeId: string; patch: unknown }> = [];
  const prompts: string[] = [];
  let validateCalls = 0;
  let turnCalls = 0;

  return {
    applied,
    prompts,
    get validateCalls() {
      return validateCalls;
    },
    get turnCalls() {
      return turnCalls;
    },
    deps: {
      seeded: new Set(["n1"]),
      validate: async () => {
        const next =
          opts.validations[Math.min(validateCalls, opts.validations.length - 1)];
        validateCalls += 1;
        return next;
      },
      runTurn: async (_projectId: string, message: string) => {
        prompts.push(message);
        const round = opts.suggestions?.[turnCalls] ?? [];
        turnCalls += 1;
        return {
          message: "",
          rawMessage: "",
          suggestions: round as never,
          toolCalls: [],
        };
      },
      applyPatch: async (nodeId: string, patch: unknown) => {
        applied.push({ nodeId, patch });
      },
      loadNodes: async () =>
        new Map([
          ["n1", { name: "api", localCommand: "pnpm dev", ports: [{ host: 3000, container: 3000 }] }],
        ]),
    },
  };
}

test("a clean project is not repaired at all", async () => {
  // Every round costs a container, so the loop must not spend one proving
  // there is nothing wrong.
  const h = harness({ validations: [validation()] });
  const res = await repairProjectStack("p1", h.deps as never);

  assert.equal(res.ok, true);
  assert.deepEqual(res.rounds, []);
  assert.equal(h.turnCalls, 0, "the agent was asked about a passing stack");
  assert.deepEqual(h.applied, []);
});

test("one round: the failure is fixed and the loop stops", async () => {
  const h = harness({
    validations: [bootFailure(), validation()],
    suggestions: [[suggestion()]],
  });
  const res = await repairProjectStack("p1", h.deps as never);

  assert.equal(res.ok, true);
  assert.equal(res.rounds.length, 1);
  assert.equal(res.rounds[0].applied.length, 1);
  assert.equal(h.applied.length, 1);
  // Stopped: no second round once it passed.
  assert.equal(h.turnCalls, 1);
});

test("the agent is given the failing step's own output", async () => {
  // "did not answer on port 3000" is not actionable; the tail is the half that
  // tells an agent what to change.
  const h = harness({
    validations: [bootFailure(), validation()],
    suggestions: [[suggestion()]],
  });
  await repairProjectStack("p1", h.deps as never);

  assert.match(h.prompts[0], /boot:api exited 1/);
  assert.match(h.prompts[0], /Cannot find module/);
});

test("a round that proposes nothing stops immediately", async () => {
  // Re-validating would ask the same question and get the same answer — a
  // round the user pays for and learns nothing from.
  const h = harness({ validations: [bootFailure()], suggestions: [[]] });
  const res = await repairProjectStack("p1", h.deps as never);

  assert.equal(res.ok, false);
  assert.equal(res.rounds.length, 1);
  assert.match(res.stoppedBecause!, /nothing to propose/);
  assert.equal(h.validateCalls, 1, "it re-validated after changing nothing");
});

test("a round whose every suggestion is refused stops, and says which", async () => {
  const h = harness({
    validations: [bootFailure()],
    suggestions: [[suggestion({ patch: { localCommand: null } })]],
  });
  const res = await repairProjectStack("p1", h.deps as never);

  assert.equal(res.ok, false);
  assert.equal(h.applied.length, 0, "a weakening patch was applied");
  assert.match(res.stoppedBecause!, /refused/);
  assert.match(res.rounds[0].refused[0].reason, /stop being started/);
});

test("the loop gives up after the configured number of rounds", async () => {
  // Past three the agent is usually guessing, and a guess that flips a working
  // node is worse than a report.
  const h = harness({
    validations: [bootFailure()],
    suggestions: [[suggestion()], [suggestion()], [suggestion()], [suggestion()]],
  });
  const res = await repairProjectStack("p1", h.deps as never);

  assert.equal(res.ok, false);
  assert.equal(res.rounds.length, MAX_REPAIR_ROUNDS);
  assert.match(res.stoppedBecause!, new RegExp(`${MAX_REPAIR_ROUNDS} rounds`));
});

test("maxRounds is honoured, so a caller can buy fewer containers", async () => {
  const h = harness({
    validations: [bootFailure()],
    suggestions: [[suggestion()], [suggestion()]],
  });
  const res = await repairProjectStack("p1", { ...h.deps, maxRounds: 1 } as never);
  assert.equal(res.rounds.length, 1);
});

test("every round records what changed and why", async () => {
  // The safety story is that nothing happens silently: an agent that rewrote
  // three nodes has to be reviewable afterwards.
  const h = harness({
    validations: [bootFailure(), validation()],
    suggestions: [[suggestion()]],
  });
  const res = await repairProjectStack("p1", h.deps as never);

  const entry = res.rounds[0].applied[0];
  assert.equal(entry.nodeId, "n1");
  assert.match(entry.change, /installCommand: pnpm install && pnpm prisma generate/);
  assert.match(entry.reason, /generated client/);
});

test("a static-only failure is repaired too, without a sandbox", async () => {
  // A port collision or a service with no image never reaches a bootstrap, and
  // is exactly the kind of thing a patch fixes.
  const h = harness({
    validations: [
      validation({
        ok: false,
        findings: [
          {
            rule: "port-collision",
            severity: "error",
            nodeId: "n1",
            nodeName: "web",
            message: 'Port 3000 is published by "web" and "docs".',
            fix: "Change one of them.",
          },
        ],
      }),
      validation(),
    ],
    suggestions: [[suggestion({ patch: { ports: [{ host: 3001, container: 3000 }] } })]],
  });
  const res = await repairProjectStack("p1", h.deps as never);

  assert.equal(res.ok, true);
  assert.match(h.prompts[0], /Port 3000 is published/);
});

test("an info-only finding is not treated as a failure", async () => {
  // "this repo has no run command, it may be a library" is information, and
  // spending a container on it would be the loop repairing a non-problem.
  const h = harness({
    validations: [
      validation({
        findings: [
          {
            rule: "no-run-command",
            severity: "info",
            nodeId: "n2",
            nodeName: "shared",
            message: '"shared" has no run command.',
          },
        ],
      }),
    ],
  });
  const res = await repairProjectStack("p1", h.deps as never);

  assert.equal(res.ok, true);
  assert.equal(h.turnCalls, 0);
});

test("absent an explicit set, seededBy decides what may be patched", async () => {
  // The rule that matters most: a node the user wrote by hand is never
  // rewritten. It rests on a column, because "who wrote this" cannot be
  // recovered from a node's shape after the fact.
  const applied: string[] = [];
  const res = await repairProjectStack("p1", {
    // One round: the stub always reports the same failure, so more rounds
    // would re-apply the same patch and say nothing new.
    maxRounds: 1,
    validate: async () => bootFailure(),
    runTurn: async () => ({
      message: "",
      rawMessage: "",
      suggestions: [
        { nodeId: "mine", patch: { installCommand: "x" }, reason: "a" },
        { nodeId: "seeded", patch: { installCommand: "y" }, reason: "b" },
      ],
      toolCalls: [],
    }),
    loadNodes: async () =>
      new Map([
        ["mine", { name: "hand-written", localCommand: "pnpm dev", ports: null, seededBy: "user" }],
        ["seeded", { name: "from seed", localCommand: "pnpm dev", ports: null, seededBy: "detect" }],
      ]),
    applyPatch: async (nodeId: string) => {
      applied.push(nodeId);
    },
  } as never);

  assert.deepEqual(applied, ["seeded"]);
  assert.match(res.rounds[0].refused[0].reason, /edited by hand/);
});

test("a node a previous repair wrote may be revised", async () => {
  // "agent" is the loop's own work: a second round revising its first attempt
  // is the loop working, not an overwrite of a human's choice.
  const applied: string[] = [];
  await repairProjectStack("p1", {
    maxRounds: 1,
    validate: async () => bootFailure(),
    runTurn: async () => ({
      message: "",
      rawMessage: "",
      suggestions: [{ nodeId: "n", patch: { installCommand: "z" }, reason: "r" }],
      toolCalls: [],
    }),
    loadNodes: async () =>
      new Map([["n", { name: "api", localCommand: "pnpm dev", ports: null, seededBy: "agent" }]]),
    applyPatch: async (nodeId: string) => {
      applied.push(nodeId);
    },
  } as never);

  assert.deepEqual(applied, ["n"]);
});
