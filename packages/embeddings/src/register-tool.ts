import { prisma } from "@nexux/db";

const TOOL_NAME = "search_project";

export async function ensureSearchProjectTool(): Promise<void> {
  const existing = await prisma.tool.findFirst({ where: { name: TOOL_NAME } });
  const schema = {
    type: "object",
    properties: {
      project_id: { type: "string", description: "Project ID to search" },
      query: { type: "string", description: "Natural language query" },
      k: { type: "number", description: "Max hits (default 8)" },
      source_types: {
        type: "array",
        items: { type: "string", enum: ["file", "document_section", "feature", "skill", "message"] },
      },
      repo_ids: { type: "array", items: { type: "string" } },
    },
    required: ["project_id", "query"],
  };

  if (existing) {
    await prisma.tool.update({
      where: { id: existing.id },
      data: {
        provider: "cli",
        type: "command",
        command: "nexux search",
        description: "Semantic search over project docs, repos, features and skills (local LanceDB + Ollama nomic-embed-text)",
        schema,
      },
    });
    return;
  }

  await prisma.tool.create({
    data: {
      name: TOOL_NAME,
      provider: "cli",
      type: "command",
      command: "nexux search",
      description: "Semantic search over project docs, repos, features and skills (local LanceDB + Ollama nomic-embed-text)",
      schema,
    },
  });
}
