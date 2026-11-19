/**
 * Roadmap Generator
 *
 * Bridges the project definition (Definer document) and the Features system:
 * reads the definition sections and proposes development phases ("MVP",
 * "Fase 2 — Pagos"…) with features per phase. Nothing is persisted here —
 * the proposal goes through a review dialog and lands via /roadmap/apply.
 *
 * Same brain pattern as project-definer-agents.ts: single-shot OpenAI agent
 * via @ideascol/agents-generator-sdk that ends its reply with a fenced
 * ```json block.
 */

import { prisma } from "@nexux/db";
import { z } from "zod";
import { createAgentClient } from "./agents-generator";

export class EmptyDefinitionError extends Error {
  constructor() {
    super(
      "The project definition has no content yet. Complete some sections in the Definition panel first."
    );
    this.name = "EmptyDefinitionError";
  }
}

export class RoadmapParseError extends Error {
  raw: string;
  constructor(raw: string) {
    super("The AI response could not be parsed into a roadmap proposal.");
    this.name = "RoadmapParseError";
    this.raw = raw;
  }
}

export const proposedFeatureSchema = z.object({
  title: z.string().min(1),
  description: z.string().default(""),
  priority: z.enum(["low", "medium", "high", "urgent"]).default("medium"),
  acceptanceCriteria: z.array(z.string()).default([]),
  sourceSectionKeys: z.array(z.string()).default([]),
});

export const proposedPhaseSchema = z.object({
  name: z.string().min(1),
  goal: z.string().default(""),
  order: z.number().int().nonnegative().default(0),
  sourceSectionKeys: z.array(z.string()).default([]),
  features: z.array(proposedFeatureSchema).default([]),
});

export const roadmapProposalSchema = z.object({
  phases: z.array(proposedPhaseSchema).min(1),
});

export type ProposedFeature = z.infer<typeof proposedFeatureSchema>;
export type ProposedPhase = z.infer<typeof proposedPhaseSchema>;
export type RoadmapProposal = z.infer<typeof roadmapProposalSchema>;

const MAX_SECTION_CHARS = 4000;

/**
 * Render the definition document as markdown grouped by definer phase, and
 * index section keys → titles (for provenance display and key validation).
 */
export async function renderDefinitionForRoadmap(projectId: string): Promise<{
  text: string;
  sectionTitles: Record<string, string>;
}> {
  const [document, phases] = await Promise.all([
    prisma.projectDocument.findUnique({
      where: { projectId },
      include: { sections: { orderBy: { order: "asc" } } },
    }),
    prisma.phase.findMany({
      where: { projectId },
      orderBy: { order: "asc" },
    }),
  ]);

  const sections = (document?.sections ?? []).filter(
    (s) => s.status !== "empty" && s.content.trim()
  );
  if (sections.length === 0) throw new EmptyDefinitionError();

  const phaseTitle = new Map(phases.map((p) => [p.key, p.title]));
  const sectionTitles: Record<string, string> = {};
  const byPhase = new Map<string, string[]>();

  for (const s of sections) {
    sectionTitles[s.key] = s.title;
    const content =
      s.content.length > MAX_SECTION_CHARS
        ? s.content.slice(0, MAX_SECTION_CHARS) + "\n\n[…truncated]"
        : s.content;
    const chunk = `## ${s.title} (key: ${s.key})\n\n${content}`;
    const list = byPhase.get(s.phaseKey) ?? [];
    list.push(chunk);
    byPhase.set(s.phaseKey, list);
  }

  const text = [...byPhase.entries()]
    .map(
      ([phaseKey, chunks]) =>
        `# ${phaseTitle.get(phaseKey) ?? phaseKey}\n\n${chunks.join("\n\n")}`
    )
    .join("\n\n");

  return { text, sectionTitles };
}

const PROPOSAL_TAIL = `
End your reply with EXACTLY one fenced json block and nothing after it:

\`\`\`json
{
  "phases": [
    {
      "name": "MVP",
      "goal": "One or two sentences: what shipping this phase proves",
      "order": 1,
      "sourceSectionKeys": ["scope-in"],
      "features": [
        {
          "title": "Short actionable feature title",
          "description": "Markdown description of what to build and why",
          "priority": "high",
          "acceptanceCriteria": ["Given …, when …, then …"],
          "sourceSectionKeys": ["user-stories"]
        }
      ]
    }
  ]
}
\`\`\``;

function buildInstructions(sectionKeys: string[]): string {
  return `You are a senior product/tech lead turning a project definition document into a development roadmap.

Rules:
- Propose 2 to 4 development phases. The FIRST phase is always the MVP: the smallest coherent slice that proves the core loop end to end.
- Each phase has 3 to 8 features. Features must be concrete and implementable — one PR-sized unit of work each, not epics.
- Write feature titles and descriptions in the same language the definition document is written in.
- priority is one of: low | medium | high | urgent.
- acceptanceCriteria: 2 to 5 short, testable criteria per feature.
- sourceSectionKeys (on phases and features): cite ONLY keys from this list: ${sectionKeys.join(", ")}. Cite the sections that motivated the item.
- Do not invent requirements that contradict the definition; when the definition is silent, make the smallest reasonable assumption.
${PROPOSAL_TAIL}`;
}

/** Exported for unit tests; callers should go through generateRoadmapProposal. */
export function extractJsonBlock(response: string): unknown | null {
  try {
    const fenced = response.match(/```json\s*([\s\S]*?)\s*```/);
    if (fenced) return JSON.parse(fenced[1]);
    const direct = response.match(/\{[\s\S]*\}/);
    if (direct) return JSON.parse(direct[0]);
    return null;
  } catch {
    return null;
  }
}

/**
 * Drop hallucinated section keys instead of rejecting the proposal.
 * Exported for unit tests.
 */
export function sanitizeKeys(
  proposal: RoadmapProposal,
  valid: Set<string>
): RoadmapProposal {
  return {
    phases: proposal.phases.map((p) => ({
      ...p,
      sourceSectionKeys: p.sourceSectionKeys.filter((k) => valid.has(k)),
      features: p.features.map((f) => ({
        ...f,
        sourceSectionKeys: f.sourceSectionKeys.filter((k) => valid.has(k)),
      })),
    })),
  };
}

export async function generateRoadmapProposal(projectId: string): Promise<{
  proposal: RoadmapProposal;
  sectionTitles: Record<string, string>;
}> {
  const { text, sectionTitles } = await renderDefinitionForRoadmap(projectId);
  const { client, apiKey, modelProvider, modelName } = await createAgentClient();

  const agent = client.defineAgent({
    name: "roadmap-generator",
    instructions: buildInstructions(Object.keys(sectionTitles)),
    modelProvider,
    modelName,
    apiKey,
    maxToolIterations: 1,
  });

  const message = `Here is the project definition document:\n\n${text}\n\nGenerate the development roadmap now.`;

  let lastRaw = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await agent.run(
      attempt === 0
        ? message
        : `${message}\n\nYour previous reply was not valid JSON matching the contract. Reply with ONLY the fenced json block this time.`
    );
    lastRaw = result.message || "";
    const parsed = roadmapProposalSchema.safeParse(extractJsonBlock(lastRaw));
    if (parsed.success) {
      return {
        proposal: sanitizeKeys(parsed.data, new Set(Object.keys(sectionTitles))),
        sectionTitles,
      };
    }
  }
  throw new RoadmapParseError(lastRaw);
}

/** aiRefinement blob composed at apply time — feeds buildFeaturePrompt. */
export function composeAiRefinement(
  acceptanceCriteria: string[],
  sourceSectionKeys: string[],
  sectionTitles: Record<string, string>
): string | null {
  const parts: string[] = [];
  if (acceptanceCriteria.length > 0) {
    parts.push(
      `## Acceptance criteria\n${acceptanceCriteria.map((c) => `- ${c}`).join("\n")}`
    );
  }
  if (sourceSectionKeys.length > 0) {
    parts.push(
      `## Source: definition sections\n${sourceSectionKeys
        .map((k) => `- ${sectionTitles[k] ?? k} (${k})`)
        .join("\n")}`
    );
  }
  return parts.length > 0 ? parts.join("\n\n") : null;
}
