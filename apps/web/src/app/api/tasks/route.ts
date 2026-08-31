import { prisma } from "@nexux/db";
import { NextRequest, NextResponse } from "next/server";
import { getActiveWorkspaceId } from "@/lib/workspace";

export const dynamic = "force-dynamic";

/** Recent agent runs across every project of the active workspace. */
export async function GET(req: NextRequest) {
  const limit = Math.min(
    Number(new URL(req.url).searchParams.get("limit")) || 20,
    50,
  );
  const workspaceId = await getActiveWorkspaceId();

  const tasks = await prisma.sandboxTask.findMany({
    where: { sandbox: { project: { workspaceId } } },
    orderBy: { createdAt: "desc" },
    take: limit,
    select: {
      id: true,
      kind: true,
      status: true,
      prompt: true,
      prUrl: true,
      previewUrl: true,
      costUsd: true,
      createdAt: true,
      feature: { select: { id: true, title: true } },
      sandbox: {
        select: {
          name: true,
          provider: true,
          project: { select: { id: true, name: true } },
        },
      },
    },
  });

  return NextResponse.json(
    tasks.map((t) => ({
      id: t.id,
      kind: t.kind,
      status: t.status,
      title: t.feature?.title ?? t.prompt,
      prUrl: t.prUrl,
      previewUrl: t.previewUrl,
      costUsd: t.costUsd,
      createdAt: t.createdAt,
      provider: t.sandbox.provider,
      projectId: t.sandbox.project.id,
      projectName: t.sandbox.project.name,
    })),
  );
}
