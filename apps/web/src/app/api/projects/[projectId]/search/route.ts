import { NextResponse } from "next/server";
import { searchProject } from "@nexux/embeddings";
import type { SourceType } from "@nexux/embeddings/chunker";
import { OllamaUnavailableError } from "@nexux/embeddings/embedder";

import { ollamaHostForProject } from "@/lib/ollama-host";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ projectId: string }> },
) {
  const { projectId } = await params;
  const body = await request.json().catch(() => ({}));

  const query = typeof body?.query === "string" ? body.query.trim() : "";
  if (!query) {
    return NextResponse.json({ error: "query required" }, { status: 400 });
  }

  const k = typeof body?.k === "number" && body.k > 0 ? Math.min(body.k, 50) : 8;
  const sourceTypes = Array.isArray(body?.sourceTypes)
    ? (body.sourceTypes as SourceType[])
    : undefined;
  const repoIds = Array.isArray(body?.repoIds) ? (body.repoIds as string[]) : undefined;
  const provider = body?.provider ?? "ollama-nomic";

  try {
    const { host } = await ollamaHostForProject(projectId);
    const grouped = await searchProject(projectId, query, {
      k,
      sourceTypes,
      repoIds,
      provider,
      ollamaHost: host,
    });
    return NextResponse.json(grouped);
  } catch (err) {
    if (err instanceof OllamaUnavailableError) {
      return NextResponse.json({ error: err.message }, { status: 503 });
    }
    const message = err instanceof Error ? err.message : "Search failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
