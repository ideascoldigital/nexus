import { prisma } from "@nexux/db";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { detectRepoUrl } from "@/lib/git-remote";
import { isCheckedOut } from "@/lib/repo-clone";

type Params = { params: Promise<{ projectId: string }> };

const addRepoSchema = z.object({
  name: z.string().min(1, "Name is required"),
  repoUrl: z.string().url().optional().or(z.literal("")),
  localPath: z.string().optional().or(z.literal("")),
  isMain: z.boolean().default(false),
  /** Git credential to clone with; omitted uses the provider-wide fallback. */
  gitCredentialId: z.string().optional().or(z.literal("")),
});

const GIT_PROVIDERS = ["github", "gitlab", "bitbucket"];

export async function GET(_req: NextRequest, { params }: Params) {
  const { projectId } = await params;

  const repos = await prisma.repository.findMany({
    where: { projectId },
    orderBy: [{ isMain: "desc" }, { createdAt: "asc" }],
  });

  return NextResponse.json(repos);
}

export async function POST(req: NextRequest, { params }: Params) {
  const { projectId } = await params;
  const body = await req.json();
  const parsed = addRepoSchema.safeParse(body);

  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const { name, localPath, isMain } = parsed.data;

  // Rejected rather than ignored: a credential that is not a git one would be
  // stored and then silently never used, since the clone only ever asks for the
  // remote's provider.
  const gitCredentialId = parsed.data.gitCredentialId || null;
  if (gitCredentialId) {
    const cred = await prisma.cloudCredential.findUnique({
      where: { id: gitCredentialId },
      select: { provider: true },
    });
    if (!cred || !GIT_PROVIDERS.includes(cred.provider)) {
      return NextResponse.json(
        { error: "Not a saved git credential" },
        { status: 400 },
      );
    }
  }
  // No URL given but a local checkout is — read its origin remote so the
  // repo is cloneable on sandboxes without retyping the URL.
  const repoUrl =
    parsed.data.repoUrl ||
    (localPath ? await detectRepoUrl(localPath) : null);

  // If setting as main, unset other mains
  if (isMain) {
    await prisma.repository.updateMany({
      where: { projectId, isMain: true },
      data: { isMain: false },
    });
  }

  const repo = await prisma.repository.create({
    data: {
      projectId,
      name,
      repoUrl: repoUrl || null,
      localPath: localPath || null,
      // "ready" means a working copy is actually there. Typing a path is not
      // the same as having cloned into it — treating it as such is what made
      // repositories on a freshly imported install claim to be checked out.
      cloneStatus:
        localPath && (await isCheckedOut(localPath)) ? "ready" : "pending",
      isMain,
      gitCredentialId,
    },
  });

  return NextResponse.json(repo, { status: 201 });
}
