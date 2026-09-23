// Spec 25, piece 2 — validate, read the failure, patch, re-validate.
//
// Spec 24 made the failure readable: a `boot:api` step carrying
// `error TS2307: Cannot find module '@/generated/prisma'` in its tail. A human
// reads that and knows the install is missing a codegen step. The system did
// not, so the loop stayed open — the developer was still the one closing it.
//
// This closes it. The agent is the stack assistant with a different prompt and
// a different caller: its suggestion format is already an applied patch with a
// reason, and its tools (read a repo file, search the project) are already the
// right three. A second agent would be a second definition of what a stack
// patch is.
//
// What it may actually change is decided by lib/stack/repair.ts, not by the
// prompt below. See the note there about why.

import { prisma } from "@nexux/db";

import { describePatch, reviewRepairs } from "@/lib/stack/repair";
import type { StackSuggestion } from "@/lib/stack/types";
import { runStackAssistantTurn } from "./stack-assistant-agent";
import { validateProject } from "./stack-validation";

/**
 * How many times the loop may try.
 *
 * Each round costs a validation — a container, and on a cloud provider real
 * money. Three is enough for the failure classes worth automating: a missing
 * codegen step, a wrong install command, an env var with no value. Past that
 * the agent is usually guessing, and a guess that flips a working node is
 * worse than a report.
 */
export const MAX_REPAIR_ROUNDS = 3;

export type RepairRound = {
  round: number;
  /** The failing steps and findings this round was given. */
  problem: string;
  applied: Array<{ nodeId: string; nodeName: string; change: string; reason: string }>;
  refused: Array<{ reason: string; suggestion: string }>;
  /** Did validation pass after this round's patches? */
  ok: boolean;
};

export type RepairResult = {
  rounds: RepairRound[];
  /** True when validation ends clean. */
  ok: boolean;
  /** Why the loop stopped, when it did not end clean. */
  stoppedBecause?: string;
};

const REPAIR_INSTRUCTIONS = `You are repairing a Nexus project's stack definition so the project actually runs.

You will be given what a real validation reported: static findings about the definition, and the steps a provisioned sandbox recorded — including, for a failed boot, the tail of the app's own output.

Your job is to fix the DEFINITION so the failure goes away. Read the repo to find out what the project actually needs; do not guess from the error message alone.

Hard rules:
- Fix the cause. A missing codegen step means adding it to the install command, not removing the build.
- NEVER remove a run command, a port, or anything else the validation checks. Making the check not run is not making it pass.
- Only patch nodes by nodeId, from get_stack_context.
- If you cannot tell what is wrong, say so and propose nothing. A wrong patch costs more than no patch.

End your reply with the suggestions json block, exactly as documented, containing only nodeId + patch + reason. Omit the block when you have nothing to propose.`;

function describeProblem(validation: Awaited<ReturnType<typeof validateProject>>): string {
  const lines: string[] = [];

  for (const f of validation.findings) {
    if (f.severity === "info") continue;
    lines.push(
      `- [${f.severity}] ${f.nodeName ? `"${f.nodeName}": ` : ""}${f.message}${f.fix ? ` (${f.fix})` : ""}`,
    );
  }

  const observed = validation.observed;
  if (observed && !observed.unavailable) {
    for (const step of observed.failed) {
      lines.push(`- step ${step.step} exited ${step.exitCode}`);
      if (step.tail) {
        // The tail is the actionable half — "did not answer on port 3000" says
        // nothing on its own.
        lines.push("  output:");
        for (const line of step.tail.trim().split("\n").slice(-20)) {
          lines.push(`    ${line}`);
        }
      }
    }
  }

  return lines.join("\n");
}

/**
 * Runs the loop.
 *
 * `apply` is injected so the route can pass the real writer and the tests can
 * pass a recorder — the orchestration is what is worth testing here, and it
 * should not need a database to exercise.
 */
export async function repairProjectStack(
  projectId: string,
  opts: {
    maxRounds?: number;
    /** Node ids the seed created; only these may be patched. */
    seeded?: Set<string>;
    runTurn?: typeof runStackAssistantTurn;
    validate?: typeof validateProject;
    applyPatch?: (nodeId: string, patch: NonNullable<StackSuggestion["patch"]>) => Promise<void>;
    /**
     * The canvas, as the applier's rules need to read it. Injected for the
     * same reason as the rest: the orchestration is what is worth testing, and
     * it should not need a database to exercise.
     */
    loadNodes?: typeof loadNodeContext;
  } = {},
): Promise<RepairResult> {
  const maxRounds = opts.maxRounds ?? MAX_REPAIR_ROUNDS;
  const runTurn = opts.runTurn ?? runStackAssistantTurn;
  const validate = opts.validate ?? validateProject;
  const applyPatch = opts.applyPatch ?? defaultApplyPatch;
  const loadNodes = opts.loadNodes ?? loadNodeContext;

  const rounds: RepairRound[] = [];

  for (let round = 1; round <= maxRounds; round++) {
    const validation = await validate(projectId);
    const failed = validation.observed?.failed ?? [];
    const blocking = validation.findings.filter((f) => f.severity !== "info");

    if (validation.ok && failed.length === 0 && blocking.length === 0) {
      return { rounds, ok: true };
    }

    const problem = describeProblem(validation);
    const nodes = await loadNodes(projectId);
    // Whose node is whose, from the column the seed writes. An explicit set
    // overrides it (the tests pass one); otherwise anything not marked
    // "detect" or "agent" is the user's and is left alone.
    const seeded =
      opts.seeded ??
      new Set(
        [...nodes.entries()]
          .filter(([, n]) => n.seededBy === "detect" || n.seededBy === "agent")
          .map(([id]) => id),
      );

    const turn = await runTurn(
      projectId,
      `${REPAIR_INSTRUCTIONS}\n\n## What validation reported\n\n${problem}`,
      [],
    );

    const { accepted, rejected } = reviewRepairs(turn.suggestions, { nodes, seeded });

    if (accepted.length === 0) {
      rounds.push({
        round,
        problem,
        applied: [],
        refused: rejected.map((r) => ({
          reason: r.reason,
          suggestion: r.suggestion.reason,
        })),
        ok: false,
      });
      // Nothing was applied, so re-validating would ask the same question and
      // get the same answer. Stopping here saves a round the user pays for.
      return {
        rounds,
        ok: false,
        stoppedBecause:
          rejected.length > 0
            ? "every proposed change was refused"
            : "the agent had nothing to propose",
      };
    }

    const applied: RepairRound["applied"] = [];
    for (const suggestion of accepted) {
      await applyPatch(suggestion.nodeId!, suggestion.patch!);
      applied.push({
        nodeId: suggestion.nodeId!,
        nodeName: nodes.get(suggestion.nodeId!)?.name ?? suggestion.nodeId!,
        change: describePatch(suggestion.patch!),
        reason: suggestion.reason,
      });
    }

    const after = await validate(projectId);
    const stillFailing =
      !after.ok ||
      (after.observed?.failed.length ?? 0) > 0 ||
      after.findings.some((f) => f.severity !== "info");

    rounds.push({
      round,
      problem,
      applied,
      refused: rejected.map((r) => ({
        reason: r.reason,
        suggestion: r.suggestion.reason,
      })),
      ok: !stillFailing,
    });

    if (!stillFailing) return { rounds, ok: true };
  }

  return {
    rounds,
    ok: false,
    stoppedBecause: `still failing after ${maxRounds} rounds`,
  };
}

/** Node ids → the fields the applier's rules read, plus the display name. */
async function loadNodeContext(projectId: string) {
  const rows = await prisma.stackNode.findMany({
    where: { projectId },
    select: {
      id: true,
      name: true,
      localCommand: true,
      ports: true,
      seededBy: true,
    },
  });
  return new Map(
    rows.map((r) => [
      r.id,
      {
        name: r.name,
        localCommand: r.localCommand,
        ports: r.ports,
        seededBy: r.seededBy,
      },
    ]),
  );
}

async function defaultApplyPatch(
  nodeId: string,
  patch: NonNullable<StackSuggestion["patch"]>,
): Promise<void> {
  await prisma.stackNode.update({
    where: { id: nodeId },
    // Marked as the agent's: a later repair may revise its own work, and a
    // reader can tell which nodes were never touched by a human.
    data: { ...(patch as Record<string, unknown>), seededBy: "agent" },
  });
}
