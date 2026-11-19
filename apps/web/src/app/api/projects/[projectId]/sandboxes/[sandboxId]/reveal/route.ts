import fs from "fs";
import { spawn } from "child_process";
import { prisma } from "@nexux/db";
import { NextRequest, NextResponse } from "next/server";
import { openerCommand } from "@/app/api/open-url/route";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ projectId: string; sandboxId: string }> };

/**
 * Reveal a LOCAL sandbox's files in the OS file manager. Local sandboxes
 * bind-mount repos that have no clone URL (localPath → /opt/nexus/<slug>),
 * so those host folders ARE the sandbox's working files. Cloned repos live
 * inside the container's filesystem — Docker Desktop's VM on macOS — where
 * no Finder can follow; those get a 409 that says so.
 *
 * Never opens an arbitrary path: only Repository.localPath rows of this
 * sandbox's own project, and only ones that exist on disk.
 */
export async function POST(_req: NextRequest, { params }: Params) {
  const { projectId, sandboxId } = await params;

  const sandbox = await prisma.sandbox.findFirst({
    where: { id: sandboxId, projectId },
    select: { provider: true, dockerEndpointId: true },
  });
  if (!sandbox) {
    return NextResponse.json({ error: "Sandbox not found" }, { status: 404 });
  }
  if (sandbox.provider !== "local") {
    return NextResponse.json(
      { error: "Only local sandboxes have files on this machine" },
      { status: 400 },
    );
  }

  if (sandbox.dockerEndpointId) {
    return NextResponse.json(
      { error: "This sandbox runs on a Docker endpoint — its files are on that machine, not this one" },
      { status: 400 },
    );
  }

  const repos = await prisma.repository.findMany({
    where: { projectId, repoUrl: null, NOT: { localPath: null } },
    select: { localPath: true },
  });
  const dirs = repos
    .map((r) => r.localPath!)
    .filter((p) => fs.existsSync(p));
  if (dirs.length === 0) {
    return NextResponse.json(
      {
        error:
          "This sandbox's repos were cloned inside the container — there is no host folder to open. Mount a local repo (no clone URL) to work on real files.",
      },
      { status: 409 },
    );
  }

  for (const dir of dirs) {
    const [bin, ...args] = openerCommand(process.platform, dir);
    spawn(bin, args, { detached: true, stdio: "ignore" }).unref();
  }
  return NextResponse.json({ opened: dirs });
}
