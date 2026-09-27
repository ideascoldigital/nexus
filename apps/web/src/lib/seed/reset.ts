/**
 * Reset data (spec 29 phase 3): put a running sandbox's databases back to the
 * project's seeds, then re-run the repos' install step — where migrations
 * live — through the same Retry setup path, so the branch's new migrations
 * run against the seed exactly as they did at launch.
 *
 * The seed file is normally already on the instance from launch. When the
 * project's seed was replaced since (its sha256 differs, or it was never
 * sent), it is pushed first — a reset always means "the seed as it is now".
 */

import { prisma } from "@nexux/db";
import { execRemote, renderSeedReset, seedRemoteShaCommand } from "@nexux/sandbox";

import { sandboxTarget } from "@/lib/agent-core";
import { appendSandboxLog, retrySandboxSetup } from "@/lib/sandbox-manager";
import { buildSandboxStackCompose, type SandboxStackService } from "@/lib/stack/sandbox-compose";
import { pushSeeds, seedsForLaunch, type LaunchSeed } from "./launch";

export type SeedResetResult = {
  ok: boolean;
  services: Array<{ service: string; ok: boolean; message: string }>;
  /** Retry setup's verdict, when it ran. */
  setup: { ok: boolean; failed: string[] } | null;
  log: string;
};

/**
 * The seeds a running sandbox can be reset to: the project's current seeds for
 * the services this sandbox actually runs (its recorded stack), matched by
 * compose name. Names come from the stack as it is now, so a sandbox launched
 * before services carried their node id still resolves.
 */
export async function seedsForSandbox(sandbox: {
  projectId: string;
  stackServices: unknown;
}): Promise<LaunchSeed[]> {
  const running = new Set(
    ((sandbox.stackServices as Array<{ name?: string }> | null) ?? []).map((s) => s.name).filter(Boolean) as string[],
  );
  if (running.size === 0) return [];
  const current = await buildSandboxStackCompose(sandbox.projectId, {});
  const services: SandboxStackService[] = current.services.filter((s) => running.has(s.name));
  // An explicit reset uses the seed even when it is off for new sandboxes:
  // "enabled" is about launches, and asking for this is asking for it.
  return seedsForLaunch(sandbox.projectId, services, () => undefined, { includeDisabled: true });
}

export async function resetSandboxData(
  sandboxId: string,
  opts: { service?: string; runSetup?: boolean } = {},
): Promise<SeedResetResult> {
  const sandbox = await prisma.sandbox.findUnique({ where: { id: sandboxId } });
  if (!sandbox) throw new Error("Sandbox not found");
  if (sandbox.status !== "running") {
    throw new Error(`This sandbox is ${sandbox.status}, not running — there is no database to reset.`);
  }
  let seeds = await seedsForSandbox(sandbox);
  if (opts.service) seeds = seeds.filter((s) => s.spec.service === opts.service);
  if (seeds.length === 0) {
    throw new Error(
      opts.service
        ? `This sandbox has no seed data for "${opts.service}".`
        : "None of this sandbox's services has seed data. Attach one to a database service on the Stack canvas.",
    );
  }

  const target = sandboxTarget(sandbox, "/", "root");
  const writer = await appendSandboxLog(sandboxId);
  const lines: string[] = [];
  const log = (l: string) => {
    lines.push(l);
    writer.append(l);
  };
  const services: SeedResetResult["services"] = [];
  try {
    log(`[nexux] reset data: ${seeds.map((s) => s.spec.service).join(", ")}`);
    for (const seed of seeds) {
      const onBox = await execRemote(seedRemoteShaCommand(seed.spec), { ...target, timeoutMs: 60_000 }).catch(() => null);
      if (onBox?.stdout.trim() !== seed.spec.sha256) {
        try {
          await pushSeeds([seed], target, log);
        } catch (err) {
          const message = `could not send the seed: ${err instanceof Error ? err.message : String(err)}`;
          log(`[nexux] WARN: ${seed.spec.service}: ${message}`);
          services.push({ service: seed.spec.service, ok: false, message });
          continue;
        }
      }
      const res = await execRemote(renderSeedReset(seed.spec), {
        ...target,
        // A restore is bounded by the dump, not by the network: a minute per
        // 50 MB on top of five.
        timeoutMs: 5 * 60_000 + Math.ceil(seed.spec.sizeBytes / (50 * 1024 * 1024)) * 60_000,
      }).catch((err: unknown) => ({ code: 1, stdout: "", stderr: err instanceof Error ? err.message : String(err) }));
      const out = `${res.stdout}${res.stderr}`.trim();
      for (const l of out.split("\n").filter(Boolean)) log(l);
      const summary = out.split("\n").reverse().find((l) => l.startsWith("[nexux] seed ") || l.startsWith("[nexux] WARN")) ?? "";
      services.push({
        service: seed.spec.service,
        ok: res.code === 0,
        message: summary.replace(/^\[nexux\] (WARN: )?/, "") || (res.code === 0 ? "restored" : "the restore failed"),
      });
    }
  } finally {
    await writer.close();
  }

  const restored = services.some((s) => s.ok);
  // Migrations live in the repos' install commands; re-running them is what
  // makes a reset the launch state rather than last month's schema.
  const setup = restored && opts.runSetup !== false ? await retrySandboxSetup(sandboxId) : null;
  return {
    ok: services.every((s) => s.ok) && (setup?.ok ?? true),
    services,
    setup: setup ? { ok: setup.ok, failed: setup.failed } : null,
    log: [...lines, ...(setup ? [setup.log] : [])].join("\n").slice(-8000),
  };
}
