// Spec 25, piece 1 — "here are my repos" → a starting canvas.
//
// Reads each repository, finds its runnable units, detects each one, and
// persists the graph `seedStack` derives. The inference itself is pure and
// lives in lib/stack/seed.ts; this is the part that touches the database and
// the filesystem.

import { prisma } from "@nexux/db";

import { detectRepo } from "@/lib/stack/detect";
import { seedStack, type SeedResult, type SeedUnit } from "@/lib/stack/seed";
import { findRunnableUnits } from "@/lib/stack/units";

export type SeedOutcome = SeedResult & {
  /** Repos that could not be read, with why. */
  skipped: Array<{ name: string; reason: string }>;
};

/**
 * Builds the graph without writing it.
 *
 * Split from the write so the route can offer a preview later, and so the
 * expensive half (filesystem scans) is testable on its own.
 */
export async function buildSeed(projectId: string): Promise<SeedOutcome> {
  const repos = await prisma.repository.findMany({
    where: { projectId },
    select: { id: true, name: true, localPath: true },
  });

  const entries: SeedUnit[] = [];
  const skipped: Array<{ name: string; reason: string }> = [];

  for (const repo of repos) {
    if (!repo.localPath) {
      // Seeding reads the checkout; a repo that only exists as a URL has
      // nothing to detect yet. Saying so beats omitting it silently.
      skipped.push({
        name: repo.name,
        reason: "no local checkout on this machine — clone it first",
      });
      continue;
    }

    let units;
    try {
      units = await findRunnableUnits(repo.name, repo.localPath);
    } catch (err) {
      skipped.push({
        name: repo.name,
        reason: err instanceof Error ? err.message : "could not be read",
      });
      continue;
    }

    for (const unit of units) {
      try {
        entries.push({
          unit,
          repositoryId: repo.id,
          detection: await detectRepo(unit.localPath),
        });
      } catch {
        // One unreadable unit inside a workspace should not lose the rest.
        skipped.push({ name: unit.name, reason: "could not be scanned" });
      }
    }
  }

  return { ...seedStack(entries), skipped };
}

/**
 * Seeds the canvas, refusing a non-empty one.
 *
 * Refusal rather than a merge: a merge cannot tell a deliberate edit from a
 * stale one, and silently reverting a fix the user made by hand is the worst
 * outcome available here. Re-seeding is explicit (`replace: true`), and then
 * it replaces rather than merges — for the same reason.
 */
export async function seedProjectStack(
  projectId: string,
  opts: { replace?: boolean } = {},
): Promise<SeedOutcome & { written: boolean; reason?: string }> {
  const existing = await prisma.stackNode.count({ where: { projectId } });
  if (existing > 0 && !opts.replace) {
    return {
      nodes: [],
      edges: [],
      notes: [],
      skipped: [],
      written: false,
      reason:
        "The canvas already has nodes. Seeding would overwrite edits nobody can tell from deliberate ones — pass replace to do it anyway.",
    };
  }

  const seed = await buildSeed(projectId);
  if (!seed.nodes.length) {
    return { ...seed, written: false, reason: "Nothing runnable was found." };
  }

  await prisma.$transaction(async (tx) => {
    // Nodes cascade their edges, so this clears both.
    await tx.stackNode.deleteMany({ where: { projectId } });

    const idMap = new Map<string, string>();
    for (const node of seed.nodes) {
      const created = await tx.stackNode.create({
        data: {
          projectId,
          kind: node.kind,
          name: node.name,
          runMode: node.runMode,
          repositoryId: node.repositoryId,
          image: node.image,
          dockerfile: node.dockerfile,
          workdir: node.workdir,
          ports: node.ports ?? undefined,
          env: node.env ?? undefined,
          volumes: node.volumes ?? undefined,
          command: node.command,
          phases: node.phases,
          // A repair may rewrite what the seed created; it may never touch a
          // node the user wrote (spec 25 piece 2).
          seededBy: "detect",
          posX: node.posX,
          posY: node.posY,
        },
        select: { id: true },
      });
      idMap.set(node.id, created.id);
    }

    for (const edge of seed.edges) {
      const sourceId = idMap.get(edge.sourceId);
      const targetId = idMap.get(edge.targetId);
      if (!sourceId || !targetId) continue;
      await tx.stackEdge.create({ data: { projectId, sourceId, targetId } });
    }
  });

  return { ...seed, written: true };
}
