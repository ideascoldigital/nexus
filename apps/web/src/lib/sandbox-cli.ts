// Push the `nexus` CLI and its manifest onto a running sandbox.
//
// The bootstrap already installs a CLI (packages/sandbox/src/nexus-cli.ts), but
// the manifest it writes is spec-derived: repo run commands only, no canvas
// keys and no resolved ports, because renderCloudInit runs before any of that
// is known and never sees the database. This is the upgrade path — it renders
// the same files from getSandboxProcessPlans(), which *is* the source of truth
// the dashboard's start/stop buttons use, and writes them over the bootstrap
// versions.
//
// It is also the answer to staleness. The manifest is a snapshot, so editing
// the stack canvas leaves it describing commands that no longer exist. Calling
// this after a canvas change (or on demand from the UI) re-syncs the box.

import { prisma } from "@nexux/db";
import {
  buildNexusManifest,
  execRemote,
  renderNexusCliSection,
  type NexusManifest,
} from "@nexux/sandbox";

import { sandboxReachable, sandboxTarget } from "@/lib/agent-core";
import { getSandboxProcessPlans } from "@/lib/stack/sandbox-processes";

export type PushCliResult =
  | { ok: true; processes: number; repos: number }
  | { ok: false; error: string };

/** The manifest for a project as the canvas currently describes it. */
export async function buildManifestForSandbox(
  projectId: string,
  sandboxName: string,
): Promise<NexusManifest> {
  const [project, repos, plans] = await Promise.all([
    prisma.project.findUnique({
      where: { id: projectId },
      select: { name: true },
    }),
    prisma.repository.findMany({
      where: { projectId },
      orderBy: [{ isMain: "desc" }, { createdAt: "asc" }],
      select: { name: true },
    }),
    getSandboxProcessPlans(projectId),
  ]);

  return buildNexusManifest({
    project: project?.name ?? projectId,
    sandbox: sandboxName,
    generatedAt: new Date().toISOString(),
    repos,
    processes: plans.map((p) => ({
      key: p.key,
      label: p.label,
      command: p.command,
      cwd: p.cwd,
      port: p.port,
      checkPorts: p.checkPorts,
      role: p.role,
    })),
  });
}

/**
 * Write the CLI + manifest into a sandbox.
 *
 * Runs as root: /etc/profile.d is not writable by the agent user, and the
 * bootstrap wrote both files as root too. Failures are returned rather than
 * thrown — a sandbox without a refreshed CLI is still perfectly usable, and no
 * caller should lose its own work over it.
 */
export async function pushNexusCli(
  projectId: string,
  sandboxId: string,
): Promise<PushCliResult> {
  const sandbox = await prisma.sandbox.findFirst({
    where: { id: sandboxId, projectId },
  });
  if (!sandbox) return { ok: false, error: "Sandbox not found" };
  if (!sandboxReachable(sandbox)) {
    return { ok: false, error: "Sandbox is not reachable" };
  }

  const manifest = await buildManifestForSandbox(projectId, sandbox.name);
  // renderNexusCliSection emits heredocs, so the whole thing rides as one
  // command — no quoting of the script body into argv, and no temp file.
  const script = renderNexusCliSection(manifest);

  const target = sandboxTarget(sandbox, "/opt/nexus", "root");
  try {
    const res = await execRemote(script, { ...target, timeoutMs: 60_000 });
    if (res.code !== 0) {
      return {
        ok: false,
        error:
          res.stderr.trim().split("\n").slice(-3).join("\n") ||
          `exited with code ${res.code}`,
      };
    }
    return {
      ok: true,
      processes: manifest.processes.length,
      repos: manifest.repos.length,
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
