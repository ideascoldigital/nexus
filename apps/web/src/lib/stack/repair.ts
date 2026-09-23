// Spec 25, piece 2 — the patch applier, and what it refuses.
//
// The loop is: validate → read the failures → an agent proposes patches →
// apply → re-validate. The agent half is a prompt; this half is the guarantee.
//
// That split is deliberate and load-bearing. A prompt is a *request*: "never
// delete a node" in an instruction block is a sentence the model may ignore,
// misread, or be talked out of by its own reasoning about a stubborn failure.
// The applier is where a rule actually holds, because it is the only thing
// that writes. Anything the loop must never do belongs here, not there.
//
// The failure mode this is built against is specific: an agent asked to make
// validation pass can make it pass by *removing what was failing*. Delete the
// node whose build breaks and the stack is green and useless. Every refusal
// below is one version of that.

import type { StackSuggestion, StackSuggestionPatch } from "./types";

export type RepairRejection = {
  suggestion: StackSuggestion;
  /** Why it was refused, in words the UI can show verbatim. */
  reason: string;
};

export type RepairReview = {
  accepted: StackSuggestion[];
  rejected: RepairRejection[];
};

/** Node fields a repair may never blank out. */
const LOAD_BEARING: Array<keyof StackSuggestionPatch> = [
  // A node with no run command is never started, so a validation that was
  // failing on its boot probe starts passing — by not testing it.
  "localCommand",
  // The port is what the boot probe waits on. Removing it turns "the app did
  // not answer" into "nothing was probed", which reads as success.
  "ports",
];

function isBlank(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === "string") return value.trim() === "";
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

/**
 * Whether a patch would weaken the check rather than fix the code.
 *
 * Returns the reason, or null when the patch is fine.
 */
export function weakensTheCheck(
  patch: StackSuggestionPatch | undefined,
  before: { localCommand?: string | null; ports?: unknown } | null,
): string | null {
  if (!patch) return null;

  for (const field of LOAD_BEARING) {
    if (!(field in patch)) continue;
    const next = patch[field];
    if (!isBlank(next)) continue;
    // Blanking a field that was already blank changes nothing, so it is not a
    // weakening — just a no-op the agent did not need to send.
    const prev = before?.[field as "localCommand" | "ports"];
    if (isBlank(prev)) continue;
    return field === "ports"
      ? "removes the port the boot probe waits on, which would turn a failing check into an unrun one"
      : "removes the run command, so the node would stop being started at all";
  }
  return null;
}

/**
 * Filters an agent's suggestions down to the ones a repair may apply.
 *
 * Four rules, each guarding a different way to go green without fixing
 * anything:
 *
 * 1. **Never touch a node the user wrote.** `seededBy` is not persisted yet
 *    (spec 25 piece 1 records it on the seed result, not the row), so this
 *    takes the set from the caller — the repair route passes the nodes the
 *    seed created. A node outside that set is the user's, and an agent
 *    rewriting it is the worst outcome available here.
 * 2. **Never create a node to satisfy a failing one.** A repair fixes how the
 *    project runs; adding a service the project never asked for is a guess
 *    with a container attached. Piece 1 infers services from evidence, and
 *    that is where a new node should come from.
 * 3. **Never weaken the check** — see `weakensTheCheck`.
 * 4. **Never patch a node that does not exist.** A hallucinated nodeId is the
 *    ordinary failure of a model reading a truncated tool result.
 */
export function reviewRepairs(
  suggestions: StackSuggestion[],
  ctx: {
    /** Node id → its current load-bearing fields. */
    nodes: Map<string, { localCommand?: string | null; ports?: unknown }>;
    /** Ids the seed created. Everything else is the user's. */
    seeded: Set<string>;
  },
): RepairReview {
  const accepted: StackSuggestion[] = [];
  const rejected: RepairRejection[] = [];
  const reject = (suggestion: StackSuggestion, reason: string) =>
    rejected.push({ suggestion, reason });

  for (const suggestion of suggestions) {
    if (suggestion.createService) {
      reject(
        suggestion,
        "a repair may not add services — piece 1 infers those from the repos' own evidence",
      );
      continue;
    }

    const nodeId = suggestion.nodeId;
    if (!nodeId) {
      // A repositoryId-targeted suggestion would create a node on a repo that
      // has none, which is rule 2 by another route.
      reject(suggestion, "a repair targets an existing node, by id");
      continue;
    }

    const before = ctx.nodes.get(nodeId);
    if (!before) {
      reject(suggestion, `no node ${nodeId} on this canvas`);
      continue;
    }

    if (!ctx.seeded.has(nodeId)) {
      reject(
        suggestion,
        "this node was edited by hand — a repair will not overwrite it",
      );
      continue;
    }

    if (!suggestion.patch || Object.keys(suggestion.patch).length === 0) {
      reject(suggestion, "no change proposed");
      continue;
    }

    const weakening = weakensTheCheck(suggestion.patch, before);
    if (weakening) {
      reject(suggestion, weakening);
      continue;
    }

    accepted.push(suggestion);
  }

  return { accepted, rejected };
}

/**
 * A one-line description of what a patch changes, for the diff the user reads.
 *
 * The loop's whole safety story is that nothing happens silently, so this is
 * not decoration: an agent that rewrote three nodes over two rounds has to be
 * reviewable afterwards without reading the database.
 */
export function describePatch(patch: StackSuggestionPatch): string {
  return Object.entries(patch)
    .map(([key, value]) => {
      if (value === null || value === undefined) return `${key}: cleared`;
      if (Array.isArray(value)) return `${key}: ${value.length} entr${value.length === 1 ? "y" : "ies"}`;
      return `${key}: ${String(value)}`;
    })
    .join(", ");
}
