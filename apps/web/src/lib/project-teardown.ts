// Deleting a project chat takes its project with it (spec 39): its sandboxes
// are destroyed first — real machines, a container or a cloud VM that would
// otherwise run on unowned — then the project row and its seed files go. The
// user's folders and repositories on disk are never touched. A project another
// bot still belongs to is left alone.

import fs from "node:fs/promises";

import { prisma } from "@nexux/db";

import { seedsRoot } from "@/lib/seed/store";
import { requestDestroy } from "@/lib/sandbox-manager";

const POLL_MS = 5_000;
const MAX_MS = 30 * 60_000;

const g = globalThis as { __nexuxTeardowns?: Set<string> };
const running = (g.__nexuxTeardowns ??= new Set<string>());

/** Whether the project goes too: true unless another bot still uses it. */
export async function projectGoesWithChat(projectId: string, botId: string): Promise<boolean> {
  const others = await prisma.bot.count({ where: { projectId, id: { not: botId } } });
  return others === 0;
}

/**
 * Destroy every live sandbox of the project, then delete the project. Runs in
 * the background: a sandbox still being set up cannot be destroyed until that
 * finishes, and a destroy takes a while.
 */
export function tearDownProject(projectId: string): void {
  if (running.has(projectId)) return;
  running.add(projectId);
  void (async () => {
    const started = Date.now();
    try {
      while (Date.now() - started < MAX_MS) {
        const live = await prisma.sandbox.findMany({
          where: { projectId, status: { not: "destroyed" } },
          select: { id: true, status: true },
        });
        if (live.length === 0) break;
        for (const s of live) {
          if (s.status === "destroying") continue;
          // "An operation in progress" (still provisioning): try again next round.
          await requestDestroy(s.id).catch(() => undefined);
        }
        await new Promise((r) => setTimeout(r, POLL_MS));
      }
      const left = await prisma.sandbox.count({ where: { projectId, status: { not: "destroyed" } } });
      if (left > 0) {
        console.warn(`[teardown] project ${projectId}: ${left} sandbox(es) not destroyed after 30 min; the project stays`);
        return;
      }
      await prisma.project.delete({ where: { id: projectId } }).catch(() => undefined);
      await fs.rm(seedsRoot(projectId), { recursive: true, force: true }).catch(() => undefined);
    } catch (err) {
      console.warn("[teardown] failed:", err instanceof Error ? err.message : err);
    } finally {
      running.delete(projectId);
    }
  })();
}
