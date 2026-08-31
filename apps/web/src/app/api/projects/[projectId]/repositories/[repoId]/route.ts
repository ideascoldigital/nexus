import { prisma } from "@nexux/db";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { detectRepoUrl } from "@/lib/git-remote";

type Params = { params: Promise<{ projectId: string; repoId: string }> };

const updateRepoSchema = z.object({
  name: z.string().min(1).optional(),
  repoUrl: z.string().url().optional().nullable().or(z.literal("")),
  localPath: z.string().optional().nullable().or(z.literal("")),
  cloneStatus: z.enum(["pending", "cloning", "ready", "error"]).optional(),
  isMain: z.boolean().optional(),
  /** Git credential to clone/pull with; null returns it to the provider fallback. */
  gitCredentialId: z.string().optional().nullable().or(z.literal("")),
  /** Fill repoUrl from the local checkout's origin remote. */
  detectRepoUrl: z.boolean().optional(),
});

const GIT_PROVIDERS = ["github", "gitlab", "bitbucket"];

export async function PUT(req: NextRequest, { params }: Params) {
  const { projectId, repoId } = await params;
  const body = await req.json();
  const parsed = updateRepoSchema.safeParse(body);

  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.flatten() },
      { status: 400 }
    );
  }

  // If setting as main, unset other mains
  if (parsed.data.isMain) {
    await prisma.repository.updateMany({
      where: { projectId, isMain: true },
      data: { isMain: false },
    });
  }

  const { detectRepoUrl: detect, ...data } = parsed.data;

  // "" is the form's way of saying "no credential"; store it as null so the
  // fallback applies rather than a foreign key that matches nothing.
  if (data.gitCredentialId === "") data.gitCredentialId = null;
  if (data.gitCredentialId) {
    const cred = await prisma.cloudCredential.findUnique({
      where: { id: data.gitCredentialId },
      select: { provider: true },
    });
    // A non-git credential here would be accepted by the foreign key and then
    // silently never used — the clone only asks for the remote's provider.
    if (!cred || !GIT_PROVIDERS.includes(cred.provider)) {
      return NextResponse.json(
        { error: "Not a saved git credential" },
        { status: 400 },
      );
    }
  }
  if (detect && !data.repoUrl) {
    const existing = await prisma.repository.findUnique({
      where: { id: repoId },
      select: { localPath: true },
    });
    const localPath = data.localPath || existing?.localPath;
    if (!localPath) {
      return NextResponse.json(
        { error: "No local path to read a git remote from" },
        { status: 400 },
      );
    }
    const detected = await detectRepoUrl(localPath);
    if (!detected) {
      return NextResponse.json(
        {
          error:
            "No origin remote found in the local checkout — push it to a git host or set the URL manually",
        },
        { status: 400 },
      );
    }
    data.repoUrl = detected;
  }

  const repo = await prisma.repository.update({
    where: { id: repoId },
    data,
  });

  return NextResponse.json(repo);
}

export async function DELETE(_req: NextRequest, { params }: Params) {
  const { repoId } = await params;

  await prisma.repository.delete({ where: { id: repoId } });
  return NextResponse.json({ success: true });
}
