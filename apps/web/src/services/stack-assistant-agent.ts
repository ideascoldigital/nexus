/**
 * Stack Assistant Agent (server-side)
 *
 * Agent that helps the user decide how to run their project stack: interprets
 * repo code via the embeddings semantic search, reads key files, and emits
 * structured suggestions the UI can apply to the Stack canvas.
 *
 * Tool calling is implemented as a self-managed loop over plain agent turns
 * (the model requests a tool with a bare ```json {"tool", "args"} block; we
 * execute it server-side and feed the result back). The hosted
 * agents-generator backend's native callback-tool protocol is not compatible
 * with SDK 0.8.1 (it emits legacy text markers), so we don't rely on it.
 */

import type { InlineMessage } from "@ideascol/agents-generator-sdk";
import type { Scope } from "@nexux/mcp";
import { prisma } from "@nexux/db";

import {
  defaultAgentDeps,
  type RunnableAgent,
} from "./agent-deps";
import { parseToolRequest as parseLoopToolRequest, renderToolCatalog, runToolLoop, type LoopTool } from "@/lib/assistant/loop";
import { contextTools, mcpTools } from "@/lib/assistant/tools";
import { parseStackSuggestions } from "@/lib/stack/suggestions";
import type { StackSuggestion } from "@/lib/stack/types";

/**
 * What the Stack assistant may call (spec 30): its own context tools plus the
 * MCP surface's reads — validate/describe the stack, list sandboxes, read a
 * task's logs. No writes: this panel has no approval cards; the global
 * assistant is where actions are proposed and run.
 */
const STACK_SCOPES: Scope[] = ["projects:read", "sandboxes:read", "tasks:read"];

function stackTools(projectId: string): LoopTool[] {
  return [...contextTools(projectId), ...mcpTools(STACK_SCOPES)];
}

/**
 * A reply that IS a call to one of the Stack assistant's tools. Kept for its
 * tests and callers; the loop does the same with the live tool list.
 */
export function parseToolRequest(
  response: string,
): { tool: string; args: Record<string, unknown> } | null {
  return parseLoopToolRequest(response, new Set(stackTools("_").map((t) => t.name)));
}

const INSTRUCTIONS = `You are the Stack Assistant for Nexus, a local-first dev orchestrator. The user is on the "Stack" tab: a canvas where each node is either a project repository or an infra service (postgres, redis, ...), connected by dependency edges. From this canvas Nexus generates a docker-compose.yml and can bring the whole stack up/down so AI agents get a full dev cycle.

Per node the user chooses:
- runMode "docker": repo built from its Dockerfile (or service run from an image) inside the generated compose.
- runMode "local": command runs directly on the host (e.g. "npm run dev"), outside compose.

Your job: help the user understand their repos and decide the right startup configuration — which mode, which commands, which ports/env, which infra services they need. Ground every claim in evidence using your tools.

{{TOOLS}}

Be concrete and cite files you actually read. Answer in the user's language.

## Suggestions

When you have concrete configuration to propose (run mode, commands, ports, env, services), END your final reply with ONE json code block in this exact shape so the UI can offer one-click apply:

\`\`\`json
{
  "suggestions": [
    {
      "repositoryId": "<repo id, when targeting a repo>",
      "nodeId": "<node id, when targeting an existing canvas node>",
      "createService": { "catalogKey": "postgres" },
      "patch": {
        "runMode": "docker",
        "localCommand": "npm run dev",
        "dockerfile": "Dockerfile",
        "command": "...",
        "image": "postgres:17",
        "ports": [{ "host": 3000, "container": 3000 }],
        "env": [{ "key": "DATABASE_URL", "value": "..." }],
        "volumes": [{ "host": "pgdata", "container": "/var/lib/postgresql/data" }]
      },
      "dependsOn": ["postgres"],
      "reason": "One sentence explaining why."
    }
  ]
}
\`\`\`

Rules: use ONE of nodeId / repositoryId / createService per suggestion. Service catalog keys: postgres, mysql, redis, mongo, ollama, minio, mailpit. Only include patch fields you want to change. Omit the block when only answering a question. Never mix a tool call and a suggestions block in the same reply.

\`dependsOn\` lists what that node needs in order to boot, by node name. Always set it when you propose a service something uses: an api you gave a DATABASE_URL depends on the database, a worker depends on the queue. The arrows are not decoration — the harness starts services in that order and waits for the dependency to be healthy, so a missing one is a service that boots before the database it queries, and the user would otherwise have to draw every arrow by hand. Name the node as it appears on the canvas (or as you are naming it in this same reply); a name that matches nothing is dropped. Do not list a dependency that is merely related — only what must be up first.`;

/**
 * The Stack assistant's instructions with a tool catalogue in place — also
 * what a "stack" thread of the global assistant runs with (spec 30).
 */
export function stackAssistantInstructions(toolCatalog: string): string {
  return INSTRUCTIONS.replace("{{TOOLS}}", toolCatalog);
}

// --- agent ---
// The agent is defined through the deps seam below, not here.

export interface StackTurnResult {
  message: string;
  rawMessage: string;
  suggestions: StackSuggestion[];
  toolCalls: string[];
}

/**
 * The outside world a turn touches: the agent runtime, the workspace lookup,
 * and the server-side tools. Injected so tests can drive the tool-calling loop
 * without an OpenAI key, prisma or the filesystem.
 */
export type StackTurnDeps = {
  defineAgent(spec: {
    name: string;
    instructions: string;
    workspaceId?: string;
  }): Promise<RunnableAgent>;
  workspaceIdOfProject(projectId: string): Promise<string | undefined>;
  runTool(
    tool: string,
    projectId: string,
    args: Record<string, unknown>
  ): Promise<unknown>;
};

export function defaultStackTurnDeps(): StackTurnDeps {
  const base = defaultAgentDeps();
  return {
    defineAgent: base.defineAgent,
    workspaceIdOfProject: base.workspaceIdOfProject,
    runTool: (tool, projectId, args) => {
      const found = stackTools(projectId).find((t) => t.name === tool);
      if (!found) throw new Error(`Unknown tool ${tool}`);
      return found.run(args);
    },
  };
}

export async function runStackAssistantTurn(
  projectId: string,
  userMessage: string,
  history: InlineMessage[],
  deps: StackTurnDeps = defaultStackTurnDeps()
): Promise<StackTurnResult> {
  // The tools' definitions come from the shared list; running them goes
  // through deps so tests can drive the loop without prisma or a model.
  const tools: LoopTool[] = stackTools(projectId).map((t) => ({
    ...t,
    run: (args) => Promise.resolve(deps.runTool(t.name, projectId, args)),
  }));
  const workspaceId = await deps.workspaceIdOfProject(projectId);
  const agent = await deps.defineAgent({
    name: "stack-assistant",
    instructions: INSTRUCTIONS.replace("{{TOOLS}}", renderToolCatalog(tools)),
    workspaceId,
  });
  const turn = await runToolLoop({ agent, tools, message: userMessage, history });
  const { message: visible, suggestions } = parseStackSuggestions(turn.raw);
  return {
    message: visible,
    rawMessage: turn.raw,
    suggestions,
    toolCalls: turn.toolCalls.map((c) => c.tool),
  };
}

// --- persistence (definer pattern, sessionId "stack-<projectId>") ---

export async function initStackAssistant(projectId: string) {
  const sessionId = `stack-${projectId}`;
  const existing = await prisma.conversation.findUnique({
    where: { sessionId },
    include: { messages: { orderBy: { createdAt: "asc" } } },
  });
  if (existing) return existing;
  return prisma.conversation.create({
    data: {
      projectId,
      sessionId,
      name: "Stack Assistant",
      status: "idle",
      model: "gpt-5.4",
      systemPrompt: "Stack assistant tool-calling conversation.",
    },
    include: { messages: true },
  });
}

export async function persistStackAssistantTurn(
  conversationId: string,
  userMessage: string,
  turn: StackTurnResult
) {
  await prisma.message.create({
    data: {
      conversationId,
      role: "user",
      agentRole: "user",
      content: userMessage,
    },
  });
  // Persist the RAW message (incl. suggestions block) so the client can
  // re-render Apply buttons after reload by re-parsing.
  const assistantMsg = await prisma.message.create({
    data: {
      conversationId,
      role: "assistant",
      agentRole: "stack-assistant",
      content: turn.rawMessage,
    },
  });
  await prisma.conversation.update({
    where: { id: conversationId },
    data: { lastActivity: new Date() },
  });
  return assistantMsg;
}
