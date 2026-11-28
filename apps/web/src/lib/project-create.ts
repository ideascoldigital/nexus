// Creating a project (spec 39): the one path the dashboard's wizard and the
// Nexus chat's tools both go through. Scanned folders, Git URLs and
// bootstrapped ideas all end here.

import { prisma } from "@nexux/db";
import { ensureSearchProjectTool } from "@nexux/embeddings/register-tool";

import { scaffoldBootstrapProject, BootstrapError } from "@/lib/bootstrap/scaffold";
import { detectRepoUrl } from "@/lib/git-remote";
import { isCheckedOut } from "@/lib/repo-clone";
import { SERVICE_CATALOG, SERVICE_COMMANDS } from "@/lib/stack/service-catalog";

export { BootstrapError };

export type NewRepository = {
  name: string;
  repoUrl?: string;
  localPath?: string;
  isMain?: boolean;
  gitCredentialId?: string;
};

export type NewProject = {
  name: string;
  description?: string;
  workspacePath?: string;
  repositories?: NewRepository[];
  bootstrap?: { type: string; parentPath: string };
};

/** A request that cannot be met as asked — the caller's mistake, not ours. */
export class ProjectCreateError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
    this.name = "ProjectCreateError";
  }
}

const GIT_PROVIDERS = ["github", "gitlab", "bitbucket"];

/**
 * Every referenced credential must be a saved git one — same rule as the
 * repositories route. Rejected rather than ignored: a credential that is not
 * a git one would be stored and then silently never used, since the clone
 * only ever asks for the remote's provider.
 */
export async function invalidGitCredential(
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

/**
 * Create a project in a workspace. Bootstrap scaffolds a folder on disk and
 * pre-seeds its stack; otherwise the repositories are recorded (nothing is
 * cloned here — see cloneProjectRepositories).
 */
export async function createProject(input: NewProject, workspaceId: string) {
  if (input.bootstrap) {
    const project = await createBootstrapProject({
      name: input.name,
      description: input.description,
      type: input.bootstrap.type,
      parentPath: input.bootstrap.parentPath,
      workspaceId,
    });
    await registerSearchTool();
    return project;
  }

  const repositories = input.repositories ?? [];
  if (await invalidGitCredential(repositories)) {
    throw new ProjectCreateError("Not a saved git credential");
  }

  // Repos added by local path only: read each checkout's origin remote so
  // they're cloneable on sandboxes without retyping the URL.
  const repoCreates = await Promise.all(
    repositories.map(async (repo, i) => ({
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
      name: input.name,
      description: input.description || null,
      workspaceId,
      workspacePath: input.workspacePath || null,
      repositories: { create: repoCreates },
    },
    include: { repositories: true },
  });
  await registerSearchTool();
  return project;
}

/** Register the default semantic search tool (idempotent). */
async function registerSearchTool() {
  await ensureSearchProjectTool().catch((err) =>
    console.warn("[projects] ensureSearchProjectTool failed", err),
  );
}

// Bootstrap: scaffold the workspace on disk, create the project with its
// single fresh repo, and pre-seed the Stack canvas from the template (repo
// node + its services, wired), so the wizard's Stack step opens ready.
async function createBootstrapProject(input: {
  name: string;
  description?: string;
  type: string;
  parentPath: string;
  workspaceId: string;
}) {
  const { dir, slug, template, warnings } =
    await scaffoldBootstrapProject(input);

  const project = await prisma.project.create({
    data: {
      name: input.name,
      description: input.description || null,
      workspaceId: input.workspaceId,
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
