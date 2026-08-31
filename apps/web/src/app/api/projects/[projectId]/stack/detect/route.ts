import { prisma } from "@nexux/db";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { detectRepo } from "@/lib/stack/detect";
import { columnsOf, phasesOf } from "@/lib/stack/phases";
import type { DetectionResult } from "@/lib/stack/types";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ projectId: string }> };

const bodySchema = z.union([
  z.object({ repositoryId: z.string().min(1) }),
  z.object({ all: z.literal(true) }),
]);

async function detectAndCache(repo: {
  id: string;
  localPath: string;
}): Promise<DetectionResult> {
  const result = await detectRepo(repo.localPath);
  // Cache on the canvas node if this repo is already on it. A fresh scan can
  // change what a phase means — a `make dev` newly known to drive compose — so
  // re-derive rather than leave stale phases behind. Phases the user edited by
  // hand are left alone: re-deriving would silently undo their edit, and the
  // rescan only ever knew better about what a command *does*, not what the user
  // wants run.
  const nodes = await prisma.stackNode.findMany({
    where: { repositoryId: repo.id },
  });
  await Promise.all(
    nodes.map((node) => {
      const edited =
        node.phases !== null &&
        JSON.stringify(node.phases) !== JSON.stringify(phasesOf(node));
      if (edited) {
        return prisma.stackNode.update({
          where: { id: node.id },
          data: { detection: result },
        });
      }
      const phases = phasesOf({ ...node, detection: result });
      return prisma.stackNode.update({
        where: { id: node.id },
        data: { detection: result, phases, ...columnsOf(phases) },
      });
    })
  );
  return result;
}

export async function POST(req: NextRequest, { params }: Params) {
  const { projectId } = await params;
  const parsed = bodySchema.safeParse(await req.json());

  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.flatten() },
      { status: 400 }
    );
  }

  if ("all" in parsed.data) {
    const repos = await prisma.repository.findMany({
      where: { projectId, cloneStatus: "ready", localPath: { not: null } },
    });
    const results: Record<string, DetectionResult> = {};
    await Promise.all(
      repos.map(async (repo) => {
        try {
          results[repo.id] = await detectAndCache({
            id: repo.id,
            localPath: repo.localPath!,
          });
        } catch {
          // unreadable repo — skip
        }
      })
    );
    return NextResponse.json(results);
  }

  const repo = await prisma.repository.findFirst({
    where: { id: parsed.data.repositoryId, projectId },
  });
  if (!repo) {
    return NextResponse.json({ error: "Repository not found" }, { status: 404 });
  }
  if (!repo.localPath || repo.cloneStatus !== "ready") {
    return NextResponse.json(
      { error: "Repository has no local path or is not ready" },
      { status: 400 }
    );
  }

  const result = await detectAndCache({ id: repo.id, localPath: repo.localPath });
  return NextResponse.json(result);
}
