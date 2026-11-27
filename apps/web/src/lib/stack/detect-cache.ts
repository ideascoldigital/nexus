// Recognising a repository's stack and caching it on its stack nodes. Shared
// by the Stack tab's detect route and the Nexus chat's detect tool (spec 39).

import { prisma } from "@nexux/db";

import { detectRepo } from "@/lib/stack/detect";
import { columnsOf, phasesOf } from "@/lib/stack/phases";
import type { DetectionResult } from "@/lib/stack/types";

export async function detectAndCache(repo: {
  id: string;
  localPath: string;
}): Promise<DetectionResult> {
  const result = await detectRepo(repo.localPath);
  // Cache on the canvas node if this repo is already on it. A fresh scan can
  // change what a phase means — a `make dev` newly known to drive compose — so
  // re-derive rather than leave stale phases behind. Phases the user edited by
  // hand are left alone: re-deriving would silently undo their edit, and the
  // rescan only ever knew better about what a command *does*, not what the user
  // wants run.
  const nodes = await prisma.stackNode.findMany({
    where: { repositoryId: repo.id },
  });
  await Promise.all(
    nodes.map((node) => {
      const edited =
        node.phases !== null &&
        JSON.stringify(node.phases) !== JSON.stringify(phasesOf(node));
      if (edited) {
        return prisma.stackNode.update({
          where: { id: node.id },
          data: { detection: result },
        });
      }
      const phases = phasesOf({ ...node, detection: result });
      return prisma.stackNode.update({
        where: { id: node.id },
        data: { detection: result, phases, ...columnsOf(phases) },
      });
    })
  );
  return result;
}

