import { NextResponse } from "next/server";
import { prisma } from "@nexux/db";
import { indexProject, dropProjectIndex } from "@nexux/embeddings";
import { OllamaUnavailableError } from "@nexux/embeddings/embedder";

// Coalesce concurrent builds per project: opening a project auto-indexes, so
// two tabs (or open + manual click) must share one build instead of racing on
// the LanceDB dir. Survives dev hot reloads like the prisma global.
const globalForIndex = globalThis as unknown as {
  nexuxIndexOps: Map<string, Promise<unknown>> | undefined;
};
const inflight = (globalForIndex.nexuxIndexOps ??= new Map());

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ projectId: string }> },
) {
  const { projectId } = await params;
  const rows = await prisma.embeddingIndex.findMany({
    where: { projectId },
    orderBy: { indexedAt: "desc" },
  });
  const counts = await prisma.embeddingIndex.groupBy({
    by: ["sourceType", "provider"],
    where: { projectId },
    _count: true,
    _sum: { chunkCount: true },
  });
  const lastIndexedAt = rows[0]?.indexedAt ?? null;
  return NextResponse.json({ counts, total: rows.length, lastIndexedAt });
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ projectId: string }> },
) {
  const { projectId } = await params;
  const body = await request.json().catch(() => ({}));
  const mode = body?.mode === "full" ? "full" : "incremental";
  const provider = body?.provider ?? "ollama-nomic";

  try {
    let run = inflight.get(projectId);
    if (!run) {
      run = indexProject(projectId, { mode, provider }).finally(() =>
        inflight.delete(projectId),
      );
      inflight.set(projectId, run);
    }
    const report = await run;
    return NextResponse.json(report);
  } catch (err) {
    if (err instanceof OllamaUnavailableError) {
      return NextResponse.json({ error: err.message }, { status: 503 });
    }
    const message = err instanceof Error ? err.message : "Index failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ projectId: string }> },
) {
  const { projectId } = await params;
  await dropProjectIndex(projectId);
  return NextResponse.json({ ok: true });
}
