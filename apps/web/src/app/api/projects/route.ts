import { prisma } from "@nexux/db";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { ensureSearchProjectTool } from "@nexux/embeddings/register-tool";
import { detectRepoUrl } from "@/lib/git-remote";
import { isCheckedOut } from "@/lib/repo-clone";
import { getActiveWorkspaceId } from "@/lib/workspace";
import {
  scaffoldBootstrapProject,
  BootstrapError,
} from "@/lib/bootstrap/scaffold";
import { BOOTSTRAP_TYPE_KEYS } from "@/lib/bootstrap/templates";
import {
  SERVICE_CATALOG,
  SERVICE_COMMANDS,
} from "@/lib/stack/service-catalog";

const repoSchema = z.object({
  name: z.string().min(1, "Repo name is required"),
  repoUrl: z.string().url("Must be a valid URL").optional().or(z.literal("")),
  localPath: z.string().optional().or(z.literal("")),
  isMain: z.boolean().default(false),
  /** Git credential to clone with; omitted uses the provider-wide fallback. */
  gitCredentialId: z.string().optional().or(z.literal("")),
});

const GIT_PROVIDERS = ["github", "gitlab", "bitbucket"];

/**
 * Every referenced credential must be a saved git one — same rule as the
 * repositories route. Rejected rather than ignored: a credential that is not
 * a git one would be stored and then silently never used, since the clone
 * only ever asks for the remote's provider.
 */
async function invalidGitCredential(
  repositories: Array<{ gitCredentialId?: string }>,
): Promise<boolean> {
  const ids = [
    ...new Set(
      repositories
        .map((r) => r.gitCredentialId)
        .filter((id): id is string => Boolean(id)),
    ),
  ];
  if (ids.length === 0) return false;
  const creds = await prisma.cloudCredential.findMany({
    where: { id: { in: ids } },
    select: { id: true, provider: true },
  });
  const valid = new Set(
    creds.filter((c) => GIT_PROVIDERS.includes(c.provider)).map((c) => c.id),
  );
  return ids.some((id) => !valid.has(id));
}

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

  const { name, description, workspacePath, repositories, bootstrap } =
    parsed.data;

  if (bootstrap) {
    try {
      const project = await createBootstrapProject({
        name,
        description,
        type: bootstrap.type,
        parentPath: bootstrap.parentPath,
      });
      await ensureSearchProjectTool().catch((err) =>
        console.warn("[projects] ensureSearchProjectTool failed", err),
      );
      return NextResponse.json(project, { status: 201 });
    } catch (err) {
      if (err instanceof BootstrapError) {
        return NextResponse.json({ error: err.message }, { status: err.status });
      }
      throw err;
    }
  }

  if (await invalidGitCredential(repositories ?? [])) {
    return NextResponse.json(
      { error: "Not a saved git credential" },
      { status: 400 },
    );
  }

  // Repos added by local path only: read each checkout's origin remote so
  // they're cloneable on sandboxes without retyping the URL.
  const repoCreates = await Promise.all(
    (repositories ?? []).map(async (repo, i) => ({
      name: repo.name,
      repoUrl:
        repo.repoUrl ||
        (repo.localPath ? await detectRepoUrl(repo.localPath) : null),
      localPath: repo.localPath || null,
      // A path that was typed in is not a checkout — see the repositories
      // route. Claiming otherwise is what left imported installs showing
      // repositories as present when nothing had been cloned.
      cloneStatus:
        repo.localPath && (await isCheckedOut(repo.localPath))
          ? "ready"
          : "pending",
      isMain: repo.isMain || i === 0, // first repo is main by default
      gitCredentialId: repo.gitCredentialId || null,
    })),
  );

  const project = await prisma.project.create({
    data: {
      name,
      description: description || null,
      workspaceId: await getActiveWorkspaceId(),
      workspacePath: workspacePath || null,
      repositories: { create: repoCreates },
    },
    include: {
      repositories: true,
    },
  });

  // Register default semantic search tool (idempotent).
  await ensureSearchProjectTool().catch((err) =>
    console.warn("[projects] ensureSearchProjectTool failed", err),
  );

  return NextResponse.json(project, { status: 201 });
}

// Bootstrap: scaffold the workspace on disk, create the project with its
// single fresh repo, and pre-seed the Stack canvas from the template (repo
// node + its services, wired), so the wizard's Stack step opens ready.
async function createBootstrapProject(input: {
  name: string;
  description?: string;
  type: string;
  parentPath: string;
}) {
  const { dir, slug, template, warnings } =
    await scaffoldBootstrapProject(input);

  const project = await prisma.project.create({
    data: {
      name: input.name,
      description: input.description || null,
      workspaceId: await getActiveWorkspaceId(),
      workspacePath: dir,
      bootstrapType: template.key,
      repositories: {
        create: [
          {
            name: slug,
            localPath: dir,
            cloneStatus: "ready",
            isMain: true,
          },
        ],
      },
    },
    include: { repositories: true },
  });

  const repo = project.repositories[0];
  const repoNode = await prisma.stackNode.create({
    data: {
      projectId: project.id,
      kind: "repo",
      repositoryId: repo.id,
      name: slug,
      runMode: "local",
      localCommand: template.localCommand ?? null,
      ports: template.port
        ? [{ host: template.port, container: template.port }]
        : undefined,
      posX: 120,
      posY: 200,
    },
  });

  const serviceDefs = template.services
    .map((key) => SERVICE_CATALOG.find((s) => s.key === key))
    .filter((s): s is NonNullable<typeof s> => Boolean(s));
  for (const [i, svc] of serviceDefs.entries()) {
    const node = await prisma.stackNode.create({
      data: {
        projectId: project.id,
        kind: "service",
        name: svc.key,
        runMode: "docker",
        image: svc.image,
        command: SERVICE_COMMANDS[svc.key] ?? null,
        ports: svc.ports,
        env: svc.env,
        volumes: svc.volumes,
        posX: 480,
        posY: 120 + i * 170,
      },
    });
    await prisma.stackEdge.create({
      data: {
        projectId: project.id,
        sourceId: repoNode.id,
        targetId: node.id,
      },
    });
  }

  return { ...project, bootstrapWarnings: warnings };
}
