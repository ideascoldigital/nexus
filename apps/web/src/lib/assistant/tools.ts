/**
 * Tools the assistants call (spec 30): the MCP surface, and the few context
 * tools that are not MCP (reading a repo, searching the index, the stack
 * canvas as the Stack assistant sees it).
 *
 * MCP tools come from `toolsFor(scopes)` and run through `callTool` — the
 * same parsing, scope check and errors as `/api/mcp` — so a tool added to
 * packages/mcp is available here with nothing else to change. Each is a
 * write or a read by its scope; writes are gated by the loop.
 */

import path from "path";
import { callTool, TOOLS as MCP_TOOLS, toolsFor, type NexuxContext, type Scope } from "@nexux/mcp";
import { prisma } from "@nexux/db";
import { LocalFsStorage, expandHome } from "@nexux/storage";
import { searchProject } from "@nexux/embeddings";
import { OllamaUnavailableError } from "@nexux/embeddings/embedder";

import { createMcpContext } from "@/lib/mcp-context";
import { ollamaHostForProject } from "@/lib/ollama-host";
import { detectRepo } from "@/lib/stack/detect";
import type { LoopTool } from "./loop";

const storage = new LocalFsStorage("/");

const MAX_FILE_BYTES = 40_000;
const SNIPPET_MAX = 400;

// --- context tools (were the Stack assistant's own) ---

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

/** The project-scoped context tools, bound to one project. */
export function contextTools(projectId: string): LoopTool[] {
  return [
    {
      name: "get_stack_context",
      description:
        "The project's repositories, the Stack canvas nodes/edges, and per-repo detection (Dockerfile, Makefile targets, package manager, scripts, suggested commands, env keys, ports). Call it first for anything about how the project runs.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      kind: "read",
      run: () => toolGetStackContext(projectId),
    },
    {
      name: "read_repo_file",
      description: "Read a file (package.json, Dockerfile, README…) from one of the project's repos. Max 40 KB.",
      inputSchema: {
        type: "object",
        properties: {
          repositoryId: { type: "string", description: "From get_stack_context." },
          path: { type: "string", description: "Relative to the repo root." },
        },
        required: ["repositoryId", "path"],
      },
      kind: "read",
      run: (args) => toolReadRepoFile(projectId, args),
    },
    {
      name: "search_project",
      description:
        "Semantic search over the project's indexed code and documents. Use it when you do not know which file holds something; if the index is not built, say so and use the other tools.",
      inputSchema: {
        type: "object",
        properties: { query: { type: "string" }, k: { type: "number", description: "Hits, max 20; default 8." } },
        required: ["query"],
      },
      kind: "read",
      run: (args) => toolSearchProject(projectId, args),
    },
  ];
}

/** Whether an MCP tool changes anything — decided by its scope, not a side list. */
export function isWriteTool(name: string): boolean {
  return MCP_TOOLS.find((t) => t.name === name)?.scope.endsWith(":write") ?? false;
}

/** The MCP tools a set of scopes may use, run in-process. */
export function mcpTools(scopes: readonly Scope[], ctx: NexuxContext = createMcpContext()): LoopTool[] {
  return toolsFor(scopes).map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema as Record<string, unknown>,
    kind: isWriteTool(t.name) ? "write" : "read",
    run: async (args) => {
      const res = await callTool(ctx, scopes, t.name, args);
      return res.ok ? res.result : { error: res.error };
    },
  }));
}
