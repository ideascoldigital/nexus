import { prisma } from "@nexux/db";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { expandHome } from "@nexux/storage";

import { localRequestRejection } from "@/lib/local-request";
import { listLocalProcesses, startLocalProcess } from "@/lib/local-processes";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ projectId: string }> };

/** The project's apps running on this Mac (spec 39), and ones that just ended. */
export async function GET(_req: NextRequest, { params }: Params) {
  const { projectId } = await params;
  return NextResponse.json(listLocalProcesses(projectId));
}

const startSchema = z.object({
  repo: z.string().trim().min(1).max(200),
  command: z.string().trim().min(1).max(2000),
  label: z.string().trim().max(60).optional(),
});

/**
 * Start a repository's command on this Mac — from the chat's Run card, a tap
 * by the user. It runs in that repository's own folder (from the project,
 * never a path from the request), detached, so it outlives Nexus.
 */
export async function POST(req: NextRequest, { params }: Params) {
  const rejected = localRequestRejection(req);
  if (rejected) return NextResponse.json({ error: rejected }, { status: 403 });
  const { projectId } = await params;
  const parsed = startSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Bad request" }, { status: 400 });
  const { repo, command, label } = parsed.data;
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { workspacePath: true, repositories: { select: { name: true, localPath: true } } },
  });
  if (!project) return NextResponse.json({ error: "Project not found" }, { status: 404 });
  const folder = project.repositories.find((r) => r.name === repo)?.localPath;
  if (!folder) return NextResponse.json({ error: `"${repo}" has no folder on this machine` }, { status: 400 });
  try {
    const proc = startLocalProcess({ projectId, repo, label: label || repo, command, cwd: expandHome(folder) });
    return NextResponse.json(proc, { status: 201 });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Could not start it" }, { status: 400 });
  }
}
