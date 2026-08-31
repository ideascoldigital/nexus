/**
 * Feature Assistant (server-side)
 *
 * Helps turn a rough idea into a well-scoped feature. Each turn queries the
 * project's semantic index (repos + definition) with the user's message and
 * hands the hits to the model as context, so proposals reference real files
 * and stay grounded in this codebase. When the assistant is confident it
 * emits a ```json {"feature": {...}}``` block the UI can apply to the form.
 */

import type { InlineMessage } from "@ideascol/agents-generator-sdk";

import { defaultAgentDeps, type AgentDeps } from "./agent-deps";

const INSTRUCTIONS = `You are the Feature Assistant in Nexus, a local-first dev orchestrator. The user is creating a new FEATURE: a work item that an autonomous Claude Code agent will later implement on a sandboxed clone of the project (implement → test → commit → PR).

Each user message may be preceded by a PROJECT CONTEXT block: semantic-search hits from the project's indexed repositories and planning documents. Use it to reference real files, components and conventions, and to keep scope realistic. Snippets can be stale — treat them as hints, not ground truth.

Rules:
- Reply in the user's language. Be concise — this is a side panel, not an essay.
- If the idea is too vague to scope, ask ONE clarifying question. Otherwise propose directly.
- When you have enough to propose (or refine) the feature, end your reply with exactly:

\`\`\`json
{"feature": {"title": "...", "description": "..."}}
\`\`\`

- title: imperative, specific, max 80 chars.
- description: 2-6 sentences an implementing agent can act on — what to build, where it likely lives (files/areas from context), and verifiable acceptance criteria. No fluff.
- Refine the block on later turns when the user pushes back. Never emit the block without the visible explanation before it.`;

export type FeatureSuggestion = { title: string; description: string };

export type FeatureAssistantTurn = {
  message: string;
  feature: FeatureSuggestion | null;
  usedContext: boolean;
};

/** Same shape the remote-agent prompt uses — distilled index hits. */
export async function buildContext(
  projectId: string,
  query: string,
  deps: AgentDeps = defaultAgentDeps(),
): Promise<string | null> {
  try {
    const results = await deps.search(projectId, query, 6);
    const clip = (s: string, n = 320) =>
      s.replace(/\s+/g, " ").trim().slice(0, n);
    const repoLines = results.repos
      .slice(0, 5)
      .map(
        (h) =>
          `- \`${h.filePath}\`${h.startLine ? ` (lines ${h.startLine}-${h.endLine})` : ""}: ${clip(h.snippet)}`,
      );
    const dataLines = results.projectData
      .slice(0, 3)
      .map(
        (h) => `- [${h.sourceType}] ${h.heading ?? h.filePath}: ${clip(h.snippet)}`,
      );
    if (repoLines.length === 0 && dataLines.length === 0) return null;
    const parts: string[] = [];
    if (repoLines.length > 0) parts.push("Repository:", ...repoLines);
    if (dataLines.length > 0)
      parts.push("Project knowledge:", ...dataLines);
    return parts.join("\n");
  } catch {
    // Ollama down or nothing indexed — the assistant still works, unanchored.
    return null;
  }
}

export async function runFeatureAssistantTurn(
  projectId: string,
  userMessage: string,
  history: InlineMessage[],
  deps: AgentDeps = defaultAgentDeps(),
): Promise<FeatureAssistantTurn> {
  const [context, agent] = await Promise.all([
    buildContext(projectId, userMessage, deps),
    deps
      .workspaceIdOfProject(projectId)
      .then((workspaceId) =>
        deps.defineAgent({
          name: "feature-assistant",
          instructions: INSTRUCTIONS,
          workspaceId,
        }),
      ),
  ]);

  const message = context
    ? `PROJECT CONTEXT (semantic index hits for this request):\n${context}\n\nUSER:\n${userMessage}`
    : userMessage;

  const result = await agent.run(message, { history });
  const raw = result.message ?? "";

  let feature: FeatureSuggestion | null = null;
  let visible = raw;
  const block = raw.match(/```json\s*([\s\S]*?)```/);
  if (block) {
    try {
      const parsed = JSON.parse(block[1]) as {
        feature?: { title?: unknown; description?: unknown };
      };
      if (parsed.feature?.title) {
        feature = {
          title: String(parsed.feature.title).slice(0, 200),
          description: String(parsed.feature.description ?? ""),
        };
        visible = raw.replace(block[0], "").trim();
      }
    } catch {
      // malformed block — show it verbatim rather than losing the reply
    }
  }

  return { message: visible, feature, usedContext: context !== null };
}
