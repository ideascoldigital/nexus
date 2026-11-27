import { prisma } from "@nexux/db";
import { expandHome } from "@nexux/storage";
import fs from "fs";
import { NextRequest, NextResponse } from "next/server";

import { listProjectDir, ProjectFileError, readProjectFile } from "@/lib/project-files";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ projectId: string }> };

/**
 * The Files surface on this Mac (spec 39): the project's repositories as they
 * are checked out here. No `repo`: which ones there are. `repo` + `path`
 * lists a folder in it, `repo` + `file` reads a text file — inside the repo
 * only, and never a secret (.env, keys, credentials, .git), as for the chat.
 */
export async function GET(req: NextRequest, { params }: Params) {
  const { projectId } = await params;
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { repositories: { orderBy: [{ isMain: "desc" }, { createdAt: "asc" }], select: { name: true, localPath: true } } },
  });
  if (!project) return NextResponse.json({ error: "Project not found" }, { status: 404 });
  const repos = project.repositories
    .filter((r) => r.localPath)
    .map((r) => ({ name: r.name, path: expandHome(r.localPath!) }))
    .filter((r) => fs.existsSync(r.path));

  const q = req.nextUrl.searchParams;
  const repoName = q.get("repo");
  if (!repoName) return NextResponse.json({ repos });
  const repo = repos.find((r) => r.name === repoName);
  if (!repo) return NextResponse.json({ error: `"${repoName}" is not checked out on this machine` }, { status: 404 });
  try {
    const file = q.get("file");
    if (file !== null) return NextResponse.json(await readProjectFile(repo.path, file));
    return NextResponse.json(await listProjectDir(repo.path, q.get("path") ?? "."));
  } catch (err) {
    const status = err instanceof ProjectFileError ? 400 : 500;
    return NextResponse.json({ error: err instanceof Error ? err.message : "Could not read" }, { status });
  }
}
