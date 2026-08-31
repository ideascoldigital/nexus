// Server-side glue for sandboxes: turn the Stack tab's docker service nodes
// into compose YAML for a sandbox instance. Unlike compose-io.ts this never
// touches local paths or the filesystem — repo nodes run bare on the instance
// via RepositorySetup, so only kind:"service" docker nodes are included.

import { prisma } from "@nexux/db";
import { generateCompose, type StackNodeSpec } from "@nexux/harness";

import { nodePhases } from "./phases";
import type { EnvVar, PortMapping, VolumeMapping } from "./types";

export type SandboxStackService = {
  /** Compose service name (slugified). */
  name: string;
  image: string;
  ports: PortMapping[];
};

export type SandboxStackCompose = {
  /** Empty string when the project has no eligible services. */
  yaml: string;
  services: SandboxStackService[];
  warnings: string[];
};

export async function buildSandboxStackCompose(
  projectId: string,
  opts: { previewPort?: number } = {},
): Promise<SandboxStackCompose> {
  const [nodes, edges] = await Promise.all([
    prisma.stackNode.findMany({ where: { projectId } }),
    prisma.stackEdge.findMany({ where: { projectId } }),
  ]);

  const warnings: string[] = [];
  // Only nodes compose itself owns end to end belong in a generated file: a
  // repo-owned compose file (`make docker-up`) is run from the checkout by the
  // bootstrap, and a host command has no place here at all.
  const included = nodes.filter(
    (n) =>
      n.kind === "service" &&
      nodePhases(n).some((p) => p.exec === "compose"),
  );
  const includedSet = new Set(included);
  for (const n of nodes) {
    if (n.kind !== "service" || includedSet.has(n)) continue;
    // A launcher brings up its own containers from the checkout, so it is
    // provisioned via the bootstrap instead of this compose file.
    if (!n.managesServices) {
      warnings.push(`"${n.name}" is local-mode — not provisioned in sandboxes`);
    }
  }

  const specs: StackNodeSpec[] = included.map((n) => ({
    id: n.id,
    kind: "service",
    name: n.name,
    runMode: "docker",
    image: n.image,
    command: n.command,
    ports: (n.ports as PortMapping[] | null) ?? null,
    env: (n.env as EnvVar[] | null) ?? null,
    volumes: (n.volumes as VolumeMapping[] | null) ?? null,
  }));

  for (const spec of specs) {
    for (const v of spec.volumes ?? []) {
      if (v.host.includes("/")) {
        warnings.push(
          `"${spec.name}" mounts host path ${v.host} — it may not exist on the instance`,
        );
      }
    }
    if (opts.previewPort) {
      for (const p of spec.ports ?? []) {
        if (p.host === opts.previewPort) {
          warnings.push(
            `"${spec.name}" publishes port ${p.host}, which collides with the live-preview port`,
          );
        }
      }
    }
  }

  // Only edges between included services survive; repo→service ordering is
  // structural in the bootstrap (services start before repos install).
  const includedIds = new Set(included.map((n) => n.id));
  const serviceEdges = edges
    .filter((e) => includedIds.has(e.sourceId) && includedIds.has(e.targetId))
    .map((e) => ({ sourceId: e.sourceId, targetId: e.targetId }));

  const compose = generateCompose({
    projectName: `nexux-${projectId.toLowerCase()}`,
    nodes: specs,
    edges: serviceEdges,
  });
  warnings.push(...compose.warnings);

  const services: SandboxStackService[] = included
    .filter((n) => compose.serviceNames[n.id] && n.image)
    .map((n) => ({
      name: compose.serviceNames[n.id],
      image: n.image!,
      ports: (n.ports as PortMapping[] | null) ?? [],
    }));

  return { yaml: compose.yaml, services, warnings };
}
