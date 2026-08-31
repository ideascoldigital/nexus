import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@nexux/db";
import {
  DEFAULT_SANDBOX_PREFIX,
  MAX_SANDBOX_PREFIX_LENGTH,
  normalizeSandboxPrefix,
  sandboxInstanceName,
} from "@nexux/sandbox";
import {
  clearSandboxPrefix,
  sandboxPrefixForWorkspace,
  setSandboxPrefix,
  storedSandboxPrefix,
} from "@/lib/sandbox-prefix";
import { getActiveWorkspaceId, workspaceIdOfProject } from "@/lib/workspace";

// The answer depends on the workspace cookie, so it cannot be cached at build.
export const dynamic = "force-dynamic";

// An empty string is how the form says "back to the default" — the field is
// cleared, the row goes away, and new sandboxes are named `nexux-…` again.
const putSchema = z.object({
  prefix: z.string().max(200),
  projectId: z.string().optional(),
});

/**
 * The setting is per workspace. A caller naming a project means *that*
 * project's workspace, which is normally the active one but need not be —
 * deep links and background callers carry no cookie.
 */
async function targetWorkspace(projectId: string | null | undefined) {
  return projectId
    ? workspaceIdOfProject(projectId)
    : getActiveWorkspaceId();
}

/**
 * What a generated name would look like, for the project asked about. A real
 * one rather than a mock-up: project names here are often full WSL paths, and
 * how those get trimmed to 63 characters is exactly what a preview is for.
 */
async function sampleName(
  projectId: string | null,
  prefix: string,
): Promise<string> {
  const project = projectId
    ? await prisma.project.findUnique({
        where: { id: projectId },
        select: { name: true },
      })
    : null;
  return sandboxInstanceName(project?.name ?? "my-project", "a1b2c3", prefix);
}

export async function GET(req: NextRequest) {
  const projectId = req.nextUrl.searchParams.get("projectId");
  const workspaceId = await targetWorkspace(projectId);
  const [prefix, stored] = await Promise.all([
    sandboxPrefixForWorkspace(workspaceId),
    storedSandboxPrefix(workspaceId),
  ]);
  return NextResponse.json({
    prefix,
    storedPrefix: stored,
    defaultPrefix: DEFAULT_SANDBOX_PREFIX,
    maxLength: MAX_SANDBOX_PREFIX_LENGTH,
    sample: await sampleName(projectId, prefix),
  });
}

export async function PUT(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const parsed = putSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const projectId = parsed.data.projectId ?? null;
  const workspaceId = await targetWorkspace(projectId);
  const raw = parsed.data.prefix.trim();
  if (!raw) {
    await clearSandboxPrefix(workspaceId);
    const prefix = await sandboxPrefixForWorkspace(workspaceId);
    return NextResponse.json({
      prefix,
      storedPrefix: null,
      sample: await sampleName(projectId, prefix),
    });
  }

  const normalized = normalizeSandboxPrefix(raw);
  if ("error" in normalized) {
    return NextResponse.json(
      {
        error:
          normalized.error === "too-long"
            ? `That prefix is too long — keep it under ${MAX_SANDBOX_PREFIX_LENGTH} characters.`
            : "That prefix has no letters or digits to build a name from.",
      },
      { status: 400 },
    );
  }

  await setSandboxPrefix(workspaceId, normalized.prefix);
  return NextResponse.json({
    prefix: normalized.prefix,
    storedPrefix: normalized.prefix,
    sample: await sampleName(projectId, normalized.prefix),
  });
}
