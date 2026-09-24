// "Here is what I need" → a stack proposal.
//
// The stack assistant reads your repos and describes what is *there*. This
// asks the opposite question: you say what you need, and it proposes the nodes
// that would provide it — including things no repo mentions yet, like a queue
// worker you have not written.
//
// Same agent, same tools, same suggestion format the canvas already applies.
// What differs is the instruction, and one rule inside it: propose, never
// interrogate.

import { runStackAssistantTurn } from "./stack-assistant-agent";
import type { StackSuggestion } from "@/lib/stack/types";

export type ProposalTurn = {
  /** What to show above the proposed nodes. */
  message: string;
  suggestions: StackSuggestion[];
  /** Which tools the agent used, so the UI can say it actually read the repo. */
  toolCalls: string[];
};

/**
 * The instruction.
 *
 * The one rule that shapes everything: **propose on the first reply**. Asking
 * "which repo is the worker in?" is the obvious way to be accurate and the
 * wrong trade here — a question costs a round trip and the user usually cannot
 * answer it more precisely than the agent can guess, because the thing they
 * are describing does not exist yet. A guess they can correct in one tap beats
 * a question they have to think about.
 *
 * Which is why the second rule matters: say plainly which parts were invented.
 * A proposal the user cannot audit is one they have to undo to trust.
 */
const PROPOSAL_INSTRUCTIONS = `You help set up a project's stack. The user tells you what they need; you propose the nodes that would provide it.

They may describe things that do not exist in the repos yet — a queue worker, a cache, a second service. That is expected. Propose them anyway.

How to answer:

1. Call get_stack_context first, always. What is already on the canvas and what the repos actually contain decides most of the answer.
2. Read a repo file when it would settle a real question — the package manager, whether a script exists, which port something binds. Do not read files to be thorough.
3. Propose in your FIRST substantive reply. Never ask a clarifying question instead of proposing: the user is describing something that does not exist yet, so they usually cannot answer more precisely than you can guess. A guess they correct in one tap beats a question they have to think about.
4. Say which parts you inferred and which you invented. "pnpm dev, from package.json" and "pnpm worker — no such script, adjust this" are different claims, and the user needs to tell them apart. Put that in the reason, not only in the prose.
5. Keep the prose short. Two or three lines: what you are proposing and what to check. The nodes carry the detail.

Use the existing service catalog (postgres, mysql, redis, mongo, ollama, minio, mailpit) when it covers what they asked for, and a raw image when it does not.

To propose a SECOND node from a repository that already has one — a worker beside the API, another app in a monorepo — add \`"createNode": { "name": "api-worker", "workdir": "apps/worker" }\` alongside its repositoryId. Without it a second suggestion for the same repo patches the first instead of adding a node, and the one you meant to add disappears. \`workdir\` is optional; omit it when the unit lives at the repo root.

End with the suggestions json block, exactly as documented.`;

/**
 * One turn of the proposal chat.
 *
 * Thin on purpose: the agent, its tools and the suggestion parser are the
 * assistant's, and this is a third caller of them after the side panel and the
 * repair loop. A second agent would be a second definition of what a stack
 * suggestion is.
 */
export async function proposeStack(
  projectId: string,
  request: string,
  history: Array<{ role: "user" | "assistant"; content: string }> = [],
  runTurn: typeof runStackAssistantTurn = runStackAssistantTurn,
): Promise<ProposalTurn> {
  const turn = await runTurn(
    projectId,
    // The instruction rides on every turn rather than only the first: the
    // history is replayed into a fresh agent each time, and an instruction
    // that appeared once ten messages ago is one the model has stopped
    // weighting.
    `${PROPOSAL_INSTRUCTIONS}\n\n## What they need\n\n${request}`,
    history as never,
  );

  return {
    message: turn.message,
    suggestions: turn.suggestions,
    toolCalls: turn.toolCalls,
  };
}
