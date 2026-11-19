// Bot routines, server side (spec 31): schedule math and the writes the bot's
// `routine` blocks turn into. Firing lives in bot-manager (it owns the queue).

import { CronExpressionParser } from "cron-parser";
import { prisma } from "@nexux/db";

import type { RoutineSpec } from "@/lib/bot-routines";

/** The host's timezone: crons fire in it, and the bot writes them in it. */
export function hostTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

export function isValidRoutineCron(cron: string): boolean {
  if (cron.trim().split(/\s+/).length !== 5) return false;
  try {
    CronExpressionParser.parse(cron);
    return true;
  } catch {
    return false;
  }
}

export function nextRoutineRun(cron: string, from = new Date()): Date | null {
  try {
    return CronExpressionParser.parse(cron, { currentDate: from }).next().toDate();
  } catch {
    return null;
  }
}

export type RoutineChange = { name: string; action: "created" | "updated" | "deleted" | "rejected"; reason?: string };

/**
 * Apply a reply's routine blocks for one bot, matching existing routines by
 * name (case-insensitive). New routines need a valid cron and a prompt.
 */
export async function applyRoutineSpecs(botId: string, specs: RoutineSpec[]): Promise<RoutineChange[]> {
  const changes: RoutineChange[] = [];
  for (const spec of specs) {
    const existing = (await prisma.botRoutine.findMany({ where: { botId } })).find(
      (r) => r.name.toLowerCase() === spec.name.toLowerCase(),
    );
    if (spec.delete) {
      if (existing) {
        await prisma.botRoutine.delete({ where: { id: existing.id } });
        changes.push({ name: existing.name, action: "deleted" });
      }
      continue;
    }
    if (spec.cron !== undefined && !isValidRoutineCron(spec.cron)) {
      changes.push({ name: spec.name, action: "rejected", reason: `invalid cron "${spec.cron}"` });
      continue;
    }
    if (existing) {
      const cron = spec.cron ?? existing.cron;
      const enabled = spec.enabled ?? existing.enabled;
      await prisma.botRoutine.update({
        where: { id: existing.id },
        data: {
          cron,
          prompt: spec.prompt || existing.prompt,
          enabled,
          nextRunAt: enabled ? nextRoutineRun(cron) : null,
        },
      });
      changes.push({ name: existing.name, action: "updated" });
    } else {
      if (!spec.cron || !spec.prompt) {
        changes.push({ name: spec.name, action: "rejected", reason: "a new routine needs a cron and a prompt" });
        continue;
      }
      const enabled = spec.enabled ?? true;
      await prisma.botRoutine.create({
        data: {
          botId,
          name: spec.name,
          cron: spec.cron,
          prompt: spec.prompt,
          enabled,
          nextRunAt: enabled ? nextRoutineRun(spec.cron) : null,
        },
      });
      changes.push({ name: spec.name, action: "created" });
    }
  }
  return changes;
}
