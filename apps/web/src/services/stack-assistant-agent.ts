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

import path from "path";
import type { InlineMessage } from "@ideascol/agents-generator-sdk";
import { prisma } from "@nexux/db";
import { LocalFsStorage, expandHome } from "@nexux/storage";
import { searchProject } from "@nexux/embeddings";
import { OllamaUnavailableError } from "@nexux/embeddings/embedder";

import {
  defaultAgentDeps,
  type RunnableAgent,
} from "./agent-deps";
import { ollamaHostForProject } from "@/lib/ollama-host";
import { detectRepo } from "@/lib/stack/detect";
import { parseStackSuggestions } from "@/lib/stack/suggestions";
import type { StackSuggestion } from "@/lib/stack/types";

const storage = new LocalFsStorage("/");

const MAX_FILE_BYTES = 40_000;
const MAX_TOOL_RESULT_CHARS = 24_000;
const MAX_TOOL_ITERATIONS = 6;
const SNIPPET_MAX = 400;

const INSTRUCTIONS = `You are the Stack Assistant for Nexus, a local-first dev orchestrator. The user is on the "Stack" tab: a canvas where each node is either a project repository or an infra service (postgres, redis, ...), connected by dependency edges. From this canvas Nexus generates a docker-compose.yml and can bring the whole stack up/down so AI agents get a full dev cycle.

Per node the user chooses:
- runMode "docker": repo built from its Dockerfile (or service run from an image) inside the generated compose.
- runMode "local": command runs directly on the host (e.g. "npm run dev"), outside compose.

Your job: help the user understand their repos and decide the right startup configuration — which mode, which commands, which ports/env, which infra services they need. Ground every claim in evidence using your tools.

## Tools

To call a tool, reply with ONLY a single json code block (no other text):

\`\`\`json
{ "tool": "<name>", "args": { ... } }
\`\`\`

You will receive the result as the next message (prefixed TOOL_RESULT). You may call several tools in sequence (one per reply). Available tools:

- get_stack_context — args: {}. Returns the project's repositories, current canvas nodes/edges, and per-repo detection (Dockerfile, Makefile + its targets, package manager, package.json scripts, suggested commands, env keys, ports). Call this first in most conversations.
- read_repo_file — args: { "repositoryId": "<id from get_stack_context>", "path": "<relative path>" }. Read a file (package.json, Dockerfile, README...) from a repo. Max 40KB.
- search_project — args: { "query": "<natural language>", "k": 8 }. Semantic search over the indexed codebase. Use when you don't know which file contains something. If the index is not built, say so and continue with the other tools.

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

// --- tool implementations ---

async function toolSearchProject(
  projectId: string,
  args: Record<string, unknown>
): Promise<unknown> {
  const query = typeof args.query === "string" ? args.query : "";
  if (!query) return { error: "query is required" };
  const k = typeof args.k === "number" ? Math.min(args.k, 20) : 8;
  try {
    const { host } = await ollamaHostForProject(projectId);
    const grouped = await searchProject(projectId, query, { k, ollamaHost: host });
    const hits = [...grouped.repos, ...grouped.projectData].map((h) => ({
      filePath: h.filePath,
      lines: h.startLine != null ? `${h.startLine}-${h.endLine}` : undefined,
      snippet: h.snippet.slice(0, SNIPPET_MAX),
      score: Number(h.score.toFixed(3)),
    }));
    if (hits.length === 0) {
      const indexed = await prisma.embeddingIndex.count({
        where: { projectId },
      });
      if (indexed === 0) {
        return {
          hits: [],
          note: "Search index not built. The user can build it in the project's Search tab. Use read_repo_file / get_stack_context instead.",
        };
      }
    }
    return { hits };
  } catch (err) {
    if (err instanceof OllamaUnavailableError) {
      return {
        error:
          "Ollama (embeddings provider) is not running — semantic search unavailable. Use read_repo_file instead.",
      };
    }
    return { error: (err as Error).message };
  }
}

async function toolGetStackContext(projectId: string): Promise<unknown> {
  const [project, nodes, edges] = await Promise.all([
    prisma.project.findUnique({
      where: { id: projectId },
      include: { repositories: true },
    }),
    prisma.stackNode.findMany({ where: { projectId } }),
    prisma.stackEdge.findMany({ where: { projectId } }),
  ]);
  if (!project) return { error: "Project not found" };

  const detections: Record<string, unknown> = {};
  await Promise.all(
    project.repositories.map(async (repo) => {
      if (!repo.localPath || repo.cloneStatus !== "ready") return;
      const cached = nodes.find((n) => n.repositoryId === repo.id)?.detection;
      if (cached) {
        detections[repo.id] = cached;
        return;
      }
      try {
        detections[repo.id] = await detectRepo(repo.localPath);
      } catch {
        // unreadable repo — skip
      }
    })
  );

  return {
    project: { id: project.id, name: project.name },
    repositories: project.repositories.map((r) => ({
      repositoryId: r.id,
      name: r.name,
      localPath: r.localPath,
      isMain: r.isMain,
      onCanvas: nodes.some((n) => n.repositoryId === r.id),
      detection: detections[r.id] ?? null,
    })),
    canvasNodes: nodes.map((n) => ({
      nodeId: n.id,
      kind: n.kind,
      repositoryId: n.repositoryId,
      name: n.name,
      runMode: n.runMode,
      image: n.image,
      dockerfile: n.dockerfile,
      command: n.command,
      localCommand: n.localCommand,
      ports: n.ports,
      env: n.env,
      volumes: n.volumes,
    })),
    edges: edges.map((e) => ({ sourceId: e.sourceId, targetId: e.targetId })),
  };
}

async function toolReadRepoFile(
  projectId: string,
  args: Record<string, unknown>
): Promise<unknown> {
  const repositoryId =
    typeof args.repositoryId === "string" ? args.repositoryId : "";
  const relPath = typeof args.path === "string" ? args.path : "";
  if (!repositoryId || !relPath) {
    return { error: "repositoryId and path are required" };
  }
  const repo = await prisma.repository.findFirst({
    where: { id: repositoryId, projectId },
  });
  if (!repo?.localPath) {
    return { error: "Repository not found or has no local path" };
  }
  const root = path.resolve(expandHome(repo.localPath));
  const resolved = path.resolve(root, relPath);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    return { error: "Path escapes the repository root — rejected" };
  }
  try {
    const stat = await storage.stat(resolved);
    if (!stat.isFile) return { error: "Not a file" };
    const text = await storage.readText(resolved);
    if (stat.size > MAX_FILE_BYTES) {
      return { path: relPath, truncated: true, content: text.slice(0, MAX_FILE_BYTES) };
    }
    return { path: relPath, content: text };
  } catch {
    return { error: `Cannot read "${relPath}"` };
  }
}

const TOOLS: Record<
  string,
  (projectId: string, args: Record<string, unknown>) => Promise<unknown>
> = {
  get_stack_context: (projectId) => toolGetStackContext(projectId),
  read_repo_file: toolReadRepoFile,
  search_project: toolSearchProject,
};

// --- tool-request parsing ---

// A reply that IS a tool call: a single ```json block containing {"tool", "args"}.
// Exported for unit tests.
export function parseToolRequest(
  response: string
): { tool: string; args: Record<string, unknown> } | null {
  const match = response.match(/```json\s*([\s\S]*?)\s*```/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[1]) as {
      tool?: unknown;
      args?: unknown;
    };
    if (typeof parsed.tool !== "string" || !(parsed.tool in TOOLS)) return null;
    return {
      tool: parsed.tool,
      args:
        parsed.args && typeof parsed.args === "object"
          ? (parsed.args as Record<string, unknown>)
          : {},
    };
  } catch {
    return null;
  }
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
    runTool: (tool, projectId, args) => TOOLS[tool](projectId, args),
  };
}

export async function runStackAssistantTurn(
  projectId: string,
  userMessage: string,
  history: InlineMessage[],
  deps: StackTurnDeps = defaultStackTurnDeps()
): Promise<StackTurnResult> {
  const workspaceId = await deps.workspaceIdOfProject(projectId);
  const agent = await deps.defineAgent({
    name: "stack-assistant",
    instructions: INSTRUCTIONS,
    workspaceId,
  });
  const toolCalls: string[] = [];

  const turnHistory: InlineMessage[] = [...history];
  let message = userMessage;
  let raw = "";

  for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
    const result = await agent.run(message, { history: turnHistory });
    raw = result.message || "";

    const request = parseToolRequest(raw);
    if (!request) break;

    toolCalls.push(request.tool);
    const toolResult = await deps.runTool(request.tool, projectId, request.args);
    const serialized = JSON.stringify(toolResult);

    turnHistory.push({ role: "user", content: message } as InlineMessage);
    turnHistory.push({ role: "assistant", content: raw } as InlineMessage);
    message = `TOOL_RESULT ${request.tool}: ${
      serialized.length > MAX_TOOL_RESULT_CHARS
        ? serialized.slice(0, MAX_TOOL_RESULT_CHARS) + '..."(truncated)'
        : serialized
    }`;
  }

  const { message: visible, suggestions } = parseStackSuggestions(raw);
  return { message: visible, rawMessage: raw, suggestions, toolCalls };
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
