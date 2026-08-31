// Server-side glue: load the stack graph from the DB, generate compose YAML
// via @nexux/harness, and write it under <workspace>/.nexux/.

import path from "path";
import { prisma } from "@nexux/db";
import { LocalFsStorage, expandHome } from "@nexux/storage";
import {
  generateCompose,
  type StackNodeSpec,
} from "@nexux/harness";

import type { EnvVar, PortMapping, VolumeMapping } from "./types";

const storage = new LocalFsStorage("/");

export type ProjectCompose = {
  yaml: string;
  warnings: string[];
  serviceNames: Record<string, string>;
  /** Directory the compose file belongs to, null if project has no root. */
  composeDir: string | null;
  projectName: string;
  nodes: Awaited<ReturnType<typeof loadGraph>>["nodes"];
  /** source depends_on target — drives local start order too. */
  edges: Array<{ sourceId: string; targetId: string }>;
  repos: Map<string, { localPath: string | null }>;
};

async function loadGraph(projectId: string) {
  const [nodes, edges] = await Promise.all([
    prisma.stackNode.findMany({ where: { projectId } }),
    prisma.stackEdge.findMany({ where: { projectId } }),
  ]);
  return { nodes, edges };
}

export async function buildProjectCompose(
  projectId: string
): Promise<ProjectCompose | null> {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    include: { repositories: true },
  });
  if (!project) return null;

  const { nodes, edges } = await loadGraph(projectId);
  const repos = new Map(
    project.repositories.map((r) => [r.id, { localPath: r.localPath }])
  );

  const specs: StackNodeSpec[] = nodes.map((n) => ({
    id: n.id,
    kind: n.kind as "repo" | "service",
    name: n.name,
    runMode: n.runMode as "docker" | "local",
    localPath: n.repositoryId
      ? repos.get(n.repositoryId)?.localPath
        ? expandHome(repos.get(n.repositoryId)!.localPath!)
        : null
      : null,
    image: n.image,
    dockerfile: n.dockerfile,
    buildContext: n.buildContext,
    command: n.command,
    ports: (n.ports as PortMapping[] | null) ?? null,
    env: (n.env as EnvVar[] | null) ?? null,
    volumes: (n.volumes as VolumeMapping[] | null) ?? null,
  }));

  const projectName = `nexux-${projectId.toLowerCase()}`;
  const { yaml, warnings, serviceNames } = generateCompose({
    projectName,
    nodes: specs,
    edges: edges.map((e) => ({ sourceId: e.sourceId, targetId: e.targetId })),
  });

  const mainRepo = project.repositories.find((r) => r.isMain && r.localPath);
  const rootPath = project.workspacePath ?? mainRepo?.localPath ?? null;
  const composeDir = rootPath
    ? path.join(expandHome(rootPath), ".nexux")
    : null;

  return {
    yaml,
    warnings,
    serviceNames,
    composeDir,
    projectName,
    nodes,
    edges: edges.map((e) => ({ sourceId: e.sourceId, targetId: e.targetId })),
    repos,
  };
}

export async function writeComposeFile(
  compose: ProjectCompose
): Promise<string | null> {
  if (!compose.composeDir || !compose.yaml) return null;
  const filePath = path.join(compose.composeDir, "docker-compose.yml");
  await storage.mkdir(compose.composeDir);
  await storage.write(filePath, compose.yaml);
  return filePath;
}
