import { prisma } from "@nexux/db";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getActiveWorkspaceId } from "@/lib/workspace";
import { BOOTSTRAP_TYPE_KEYS } from "@/lib/bootstrap/templates";
import { BootstrapError, createProject, ProjectCreateError } from "@/lib/project-create";

const repoSchema = z.object({
  name: z.string().min(1, "Repo name is required"),
  repoUrl: z.string().url("Must be a valid URL").optional().or(z.literal("")),
  localPath: z.string().optional().or(z.literal("")),
  isMain: z.boolean().default(false),
  /** Git credential to clone with; omitted uses the provider-wide fallback. */
  gitCredentialId: z.string().optional().or(z.literal("")),
});

const createProjectSchema = z.object({
  name: z.string().min(1, "Name is required"),
  description: z.string().optional(),
  workspacePath: z.string().optional(),
  repositories: z.array(repoSchema).optional(),
  // Bootstrap mode: start from a blank idea — scaffold a workspace dir on
  // disk instead of pointing at existing repos.
  bootstrap: z
    .object({
      type: z.enum(BOOTSTRAP_TYPE_KEYS as [string, ...string[]]),
      parentPath: z.string().min(1, "Location is required"),
    })
    .optional(),
});

export async function GET() {
  const workspaceId = await getActiveWorkspaceId();
  const projects = await prisma.project.findMany({
    where: { workspaceId },
    orderBy: { updatedAt: "desc" },
    include: {
      repositories: { orderBy: { isMain: "desc" } },
      _count: {
        select: {
          features: true,
          conversations: true,
          repositories: true,
        },
      },
    },
  });

  return NextResponse.json(projects);
}

export async function POST(req: NextRequest) {
  const body = await req.json();
  const parsed = createProjectSchema.safeParse(body);

  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const { repositories, ...rest } = parsed.data;
  try {
    const project = await createProject(
      {
        ...rest,
        repositories: repositories?.map((r) => ({
          ...r,
          repoUrl: r.repoUrl || undefined,
          localPath: r.localPath || undefined,
          gitCredentialId: r.gitCredentialId || undefined,
        })),
      },
      await getActiveWorkspaceId(),
    );
    return NextResponse.json(project, { status: 201 });
  } catch (err) {
    if (err instanceof BootstrapError || err instanceof ProjectCreateError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }
}
