/**
 * Project Definer Agents Service
 *
 * Uses the agents-generator-sdk native multi-agent (subAgents) routing.
 * One triage agent + 5 specialist subAgents. The SDK handles handoff;
 * we read `transfers` from the run result to know which specialist replied.
 */

import type { InlineMessage } from '@ideascol/agents-generator-sdk';
import { prisma } from "@nexux/db";
import { createAgentClient } from './agents-generator';
import type { RunnableAgent } from './agent-deps';

export type SpecialistRole =
  | 'project-manager'
  | 'finance-manager'
  | 'technical-architect'
  | 'product-ux'
  | 'detractor';

export type DefinerRole = SpecialistRole | 'triage';

export interface SectionUpdate {
  key: string;
  content: string;
  status?: 'empty' | 'draft' | 'approved';
}

export interface SpecialistResponse {
  role: SpecialistRole;
  content: string;
  sectionUpdates: SectionUpdate[];
}

export interface DefinerTurnResult {
  transfers: Array<{ from?: string; to?: string; reason?: string }>;
  finalMessage: string;
  finalRole: SpecialistRole;
  sectionUpdates: SectionUpdate[];
}

const SUB_AGENT_NAMES: Record<SpecialistRole, string> = {
  'project-manager': 'definer-project-manager',
  'finance-manager': 'definer-finance-manager',
  'technical-architect': 'definer-technical-architect',
  'product-ux': 'definer-product-ux',
  detractor: 'definer-detractor',
};

const NAME_TO_ROLE: Record<string, SpecialistRole> = Object.fromEntries(
  Object.entries(SUB_AGENT_NAMES).map(([role, name]) => [name, role as SpecialistRole])
) as Record<string, SpecialistRole>;

const SECTION_TAIL = `
When you have content worth persisting to the project planning document, end your reply with a JSON code block describing section updates. Use this exact shape:

\`\`\`json
{
  "sectionUpdates": [
    { "key": "<section-key>", "content": "<markdown body>", "status": "draft" }
  ]
}
\`\`\`

Only emit sectionUpdates for sections you actually authored or revised this turn. Omit the JSON block if you have nothing to persist. Prefer concise structured markdown.
`;

function defineProjectManager(client: AgentClient, apiKey: string, model: HostModelChoice) {
  return client.defineAgent({
    name: SUB_AGENT_NAMES['project-manager'],
    instructions: `You are the Project Manager specialist for a project-definition workflow.

Focus areas:
- Scope (in/out)
- Stakeholders and roles
- Milestones, timeline, dependencies
- Status, top-line risks, mitigations
- Open questions blocking progress

Be concrete: specific milestones, named stakeholders/roles, explicit scope boundaries.

Relevant section keys: overview, problem, stakeholders, scope-in, scope-out, timeline, milestones, open-questions.
${SECTION_TAIL}`,
    modelProvider: model.modelProvider,
    modelName: model.modelName,
    apiKey,
    maxToolIterations: 3,
  });
}

function defineFinanceManager(client: AgentClient, apiKey: string, model: HostModelChoice) {
  return client.defineAgent({
    name: SUB_AGENT_NAMES['finance-manager'],
    instructions: `You are the Finance Manager specialist for a project-definition workflow.

Focus areas:
- Budget breakdown (people, infra, licenses, services)
- Cost estimation with line items and assumptions
- ROI / payback period
- Funding model and burn

Show numbers in structured tables/lists with assumptions stated. Mark figures as rough estimates when based on incomplete info.

Relevant section keys: budget, roi.
${SECTION_TAIL}`,
    modelProvider: model.modelProvider,
    modelName: model.modelName,
    apiKey,
    maxToolIterations: 3,
  });
}

function defineTechnicalArchitect(client: AgentClient, apiKey: string, model: HostModelChoice) {
  return client.defineAgent({
    name: SUB_AGENT_NAMES['technical-architect'],
    instructions: `You are the Technical Architect specialist for a project-definition workflow.

Focus areas:
- Tech stack (languages, frameworks, datastores)
- Components and their responsibilities
- Integrations (third-party APIs, internal systems)
- Non-functional requirements (perf, security, observability, compliance)
- Data model sketch and key flows

Prefer pragmatic boring choices unless the user has a reason to deviate. Call out trade-offs explicitly.

Relevant section keys: tech-stack, architecture, integrations, data-model, non-functional-requirements.
${SECTION_TAIL}`,
    modelProvider: model.modelProvider,
    modelName: model.modelName,
    apiKey,
    maxToolIterations: 3,
  });
}

function defineProductUX(client: AgentClient, apiKey: string, model: HostModelChoice) {
  return client.defineAgent({
    name: SUB_AGENT_NAMES['product-ux'],
    instructions: `You are the Product/UX specialist for a project-definition workflow.

Focus areas:
- Personas and primary jobs-to-be-done
- User stories (As a... I want... so that...)
- UX flows for primary paths
- Functional requirements (numbered)
- Success metrics (activation, retention, task completion, etc.)

Phrase requirements testably. Keep user stories short and outcome-oriented.

Relevant section keys: functional-requirements, user-stories, ux-flows, success-metrics.
${SECTION_TAIL}`,
    modelProvider: model.modelProvider,
    modelName: model.modelName,
    apiKey,
    maxToolIterations: 3,
  });
}

function defineDetractor(client: AgentClient, apiKey: string, model: HostModelChoice) {
  return client.defineAgent({
    name: SUB_AGENT_NAMES.detractor,
    instructions: `You are the Detractor specialist for a project-definition workflow. You are the skeptic, the devil's advocate.

Your job is to stress-test the plan:
- Challenge assumptions (state which assumption and why it might be wrong)
- Surface missing scenarios and edge cases
- Identify likely failure modes and blast radius
- Point out weak metrics, vague scope, optimistic estimates
- Name the cheapest way the project fails

Be specific, not generic. Cite the artifact you're challenging. End each critique with a concrete suggestion (drop it, defer it, redesign it, add a guardrail).

Relevant section keys: risks, open-questions.
${SECTION_TAIL}`,
    modelProvider: model.modelProvider,
    modelName: model.modelName,
    apiKey,
    maxToolIterations: 3,
  });
}

type AgentClient = Awaited<ReturnType<typeof createAgentClient>>['client'];

/** The model every definer agent runs on — resolved once, passed down. */
type HostModelChoice = { modelProvider: string; modelName: string };

export async function buildDefinerTriage() {
  const { client, apiKey, modelProvider, modelName } = await createAgentClient();
  const model: HostModelChoice = { modelProvider, modelName };

  const pm = defineProjectManager(client, apiKey, model);
  const finance = defineFinanceManager(client, apiKey, model);
  const arch = defineTechnicalArchitect(client, apiKey, model);
  const ux = defineProductUX(client, apiKey, model);
  const detractor = defineDetractor(client, apiKey, model);

  const triage = client.defineAgent({
    name: 'definer-triage',
    instructions: `You are the triage agent for a project-definition workflow. You route the user to the best specialist and never answer the user yourself — always perform a handoff.

Specialists:
- definer-project-manager: scope, timeline, milestones, stakeholders, status/risk tracking
- definer-finance-manager: budget, cost estimation, ROI, funding model
- definer-technical-architect: stack, components, integrations, NFRs, data flow, infra
- definer-product-ux: personas, user stories, UX flows, functional requirements, success metrics
- definer-detractor: adversarial review — assumptions, weak spots, missing scenarios, failure modes

Route to one specialist. If the message clearly invites a stress-test or challenges the plan, prefer the detractor. If unrelated to project definition, default to the project manager.`,
    modelProvider: model.modelProvider,
    modelName: model.modelName,
    apiKey,
    subAgents: [pm, finance, arch, ux, detractor],
    maxToolIterations: 5,
  });

  return triage;
}

function extractJsonBlock(response: string): unknown | null {
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

/** Exported for unit tests; callers go through runDefinerTurn. */
export function parseSectionUpdates(response: string): SectionUpdate[] {
  const parsed = extractJsonBlock(response) as { sectionUpdates?: unknown } | null;
  if (!parsed || !Array.isArray(parsed.sectionUpdates)) return [];
  return (parsed.sectionUpdates as Array<Record<string, unknown>>)
    .filter((u) => u && typeof u.key === 'string' && typeof u.content === 'string')
    .map((u) => ({
      key: u.key as string,
      content: u.content as string,
      status: u.status === 'approved' ? 'approved' : 'draft',
    }));
}

/**
 * Which specialist actually answered. The SDK reports handoffs in order, so
 * the last recognized destination is the one that produced the final message.
 * Exported for unit tests.
 */
export function resolveFinalRole(
  transfers: Array<{ to_agent?: string; from_agent?: string; reason?: string }> | undefined
): SpecialistRole {
  if (!transfers || transfers.length === 0) return 'project-manager';
  for (let i = transfers.length - 1; i >= 0; i--) {
    const to = transfers[i]?.to_agent;
    if (to && NAME_TO_ROLE[to]) return NAME_TO_ROLE[to];
  }
  return 'project-manager';
}

/**
 * The triage agent a turn runs against. Injected so tests can drive the
 * handoff and section-update handling without an OpenAI key or the agent
 * backend; production callers get the real multi-agent graph.
 */
export type DefinerTurnDeps = {
  buildTriage(): Promise<RunnableAgent>;
};

export function defaultDefinerTurnDeps(): DefinerTurnDeps {
  return { buildTriage: buildDefinerTriage };
}

export async function runDefinerTurn(
  userMessage: string,
  history: InlineMessage[],
  deps: DefinerTurnDeps = defaultDefinerTurnDeps()
): Promise<DefinerTurnResult> {
  const triage = await deps.buildTriage();
  const result = await triage.run(userMessage, { history });
  const finalMessage = result.message || '';
  const finalRole = resolveFinalRole(
    result.transfers as Array<{ to_agent?: string; from_agent?: string; reason?: string }> | undefined
  );
  return {
    transfers: (result.transfers ?? []).map((t) => ({
      from: t.from_agent,
      to: t.to_agent,
      reason: t.reason,
    })),
    finalMessage,
    finalRole,
    sectionUpdates: parseSectionUpdates(finalMessage),
  };
}

const SECTION_TEMPLATE: Array<{
  key: string;
  title: string;
  phaseKey: string;
  ownerRole: SpecialistRole;
  order: number;
}> = [
  { key: 'overview', title: 'Overview', phaseKey: 'discovery', ownerRole: 'project-manager', order: 1 },
  { key: 'problem', title: 'Problem / Opportunity', phaseKey: 'discovery', ownerRole: 'project-manager', order: 2 },
  { key: 'stakeholders', title: 'Stakeholders', phaseKey: 'discovery', ownerRole: 'project-manager', order: 3 },
  { key: 'functional-requirements', title: 'Functional Requirements', phaseKey: 'requirements', ownerRole: 'product-ux', order: 1 },
  { key: 'non-functional-requirements', title: 'Non-Functional Requirements', phaseKey: 'requirements', ownerRole: 'technical-architect', order: 2 },
  { key: 'scope-in', title: 'Scope (In)', phaseKey: 'requirements', ownerRole: 'project-manager', order: 3 },
  { key: 'scope-out', title: 'Scope (Out)', phaseKey: 'requirements', ownerRole: 'project-manager', order: 4 },
  { key: 'user-stories', title: 'User Stories', phaseKey: 'requirements', ownerRole: 'product-ux', order: 5 },
  { key: 'ux-flows', title: 'UX Flows', phaseKey: 'requirements', ownerRole: 'product-ux', order: 6 },
  { key: 'tech-stack', title: 'Tech Stack', phaseKey: 'architecture', ownerRole: 'technical-architect', order: 1 },
  { key: 'architecture', title: 'Architecture', phaseKey: 'architecture', ownerRole: 'technical-architect', order: 2 },
  { key: 'integrations', title: 'Integrations', phaseKey: 'architecture', ownerRole: 'technical-architect', order: 3 },
  { key: 'data-model', title: 'Data Model', phaseKey: 'architecture', ownerRole: 'technical-architect', order: 4 },
  { key: 'budget', title: 'Budget', phaseKey: 'finance', ownerRole: 'finance-manager', order: 1 },
  { key: 'roi', title: 'ROI', phaseKey: 'finance', ownerRole: 'finance-manager', order: 2 },
  { key: 'timeline', title: 'Timeline', phaseKey: 'finance', ownerRole: 'project-manager', order: 3 },
  { key: 'milestones', title: 'Milestones', phaseKey: 'finance', ownerRole: 'project-manager', order: 4 },
  { key: 'risks', title: 'Risks', phaseKey: 'risks', ownerRole: 'detractor', order: 1 },
  { key: 'open-questions', title: 'Open Questions', phaseKey: 'risks', ownerRole: 'detractor', order: 2 },
  { key: 'success-metrics', title: 'Success Metrics', phaseKey: 'finalization', ownerRole: 'product-ux', order: 1 },
];

const PHASE_TEMPLATE: Array<{ key: string; title: string; order: number; summary: string }> = [
  { key: 'discovery', title: 'Discovery', order: 1, summary: 'Frame the project, stakeholders, problem.' },
  { key: 'requirements', title: 'Requirements', order: 2, summary: 'Functional and non-functional requirements, scope, user stories.' },
  { key: 'architecture', title: 'Architecture', order: 3, summary: 'Tech stack, components, integrations, data model.' },
  { key: 'finance', title: 'Finance & Timeline', order: 4, summary: 'Budget, ROI, timeline, milestones.' },
  { key: 'risks', title: 'Risks & Challenges', order: 5, summary: 'Detractor pass — risks and open questions.' },
  { key: 'finalization', title: 'Finalization', order: 6, summary: 'Success metrics and sign-off.' },
];

export interface InitDefinerResult {
  documentId: string;
  conversationId: string;
  phaseCount: number;
  sectionCount: number;
}

export async function initDefinerForProject(projectId: string): Promise<InitDefinerResult> {
  const existing = await prisma.projectDocument.findUnique({
    where: { projectId },
    include: { sections: true },
  });

  if (existing) {
    const conv = await prisma.conversation.findFirst({
      where: { projectId, sessionId: `definer-${projectId}` },
    });
    return {
      documentId: existing.id,
      conversationId: conv?.id ?? existing.conversationId ?? '',
      phaseCount: await prisma.phase.count({ where: { projectId } }),
      sectionCount: existing.sections.length,
    };
  }

  await prisma.phase.createMany({
    data: PHASE_TEMPLATE.map((p, idx) => ({
      projectId,
      key: p.key,
      order: p.order,
      title: p.title,
      summary: p.summary,
      status: idx === 0 ? 'active' : 'locked',
    })),
  });

  const conversation = await prisma.conversation.create({
    data: {
      projectId,
      sessionId: `definer-${projectId}`,
      name: 'Project Definition',
      status: 'idle',
      model: 'gpt-5.4',
      systemPrompt: 'Project-definer multi-agent conversation (SDK handoff).',
    },
  });

  const document = await prisma.projectDocument.create({
    data: {
      projectId,
      conversationId: conversation.id,
      sections: {
        create: SECTION_TEMPLATE.map((s) => ({
          phaseKey: s.phaseKey,
          key: s.key,
          title: s.title,
          ownerRole: s.ownerRole,
          order: s.order,
          status: 'empty',
          content: '',
        })),
      },
    },
    include: { sections: true },
  });

  return {
    documentId: document.id,
    conversationId: conversation.id,
    phaseCount: PHASE_TEMPLATE.length,
    sectionCount: document.sections.length,
  };
}

export async function persistDefinerTurn(
  conversationId: string,
  documentId: string,
  userMessage: string,
  turn: DefinerTurnResult
): Promise<{ messages: Array<{ id: string; role: string; agentRole: string; content: string }> }> {
  const created: Array<{ id: string; role: string; agentRole: string; content: string }> = [];

  const userMsg = await prisma.message.create({
    data: {
      conversationId,
      role: 'user',
      agentRole: 'user',
      content: userMessage,
    },
  });
  created.push({ id: userMsg.id, role: 'user', agentRole: 'user', content: userMessage });

  if (turn.transfers.length > 0) {
    const triageMsg = await prisma.message.create({
      data: {
        conversationId,
        role: 'system',
        agentRole: 'triage',
        content: JSON.stringify(turn.transfers),
        messageType: 'thinking',
      },
    });
    created.push({
      id: triageMsg.id,
      role: 'system',
      agentRole: 'triage',
      content: JSON.stringify(turn.transfers),
    });
  }

  const finalMsg = await prisma.message.create({
    data: {
      conversationId,
      role: 'assistant',
      agentRole: turn.finalRole,
      content: turn.finalMessage,
    },
  });
  created.push({
    id: finalMsg.id,
    role: 'assistant',
    agentRole: turn.finalRole,
    content: turn.finalMessage,
  });

  for (const update of turn.sectionUpdates) {
    const section = await prisma.projectDocumentSection.findUnique({
      where: { documentId_key: { documentId, key: update.key } },
    });
    if (!section) continue;
    await prisma.projectDocumentSection.update({
      where: { id: section.id },
      data: {
        content: update.content,
        status: update.status ?? 'draft',
      },
    });
    await prisma.projectDocumentRevision.create({
      data: {
        sectionId: section.id,
        content: update.content,
        authorRole: turn.finalRole,
        messageId: finalMsg.id,
      },
    });
  }

  await prisma.conversation.update({
    where: { id: conversationId },
    data: { lastActivity: new Date() },
  });

  return { messages: created };
}
