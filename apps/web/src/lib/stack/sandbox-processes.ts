// The processes a sandbox can run — one entry per startable long-running
// command, so a multi-repo project can boot its web app and its functions
// emulator independently instead of sharing a single "live preview".
//
// The stack canvas is the source of truth: every `run` phase of a local repo
// node becomes a process, and every `services` phase becomes a launcher (still
// startable — that is how firebase emulators or `make docker-up` come back
// after a restart). A repo with no node on the canvas falls back to its
// RepositorySetup.runCommand, so a project that never drew a stack keeps
// working.
//
// This runs on the host: resolving `pnpm dev` to the script it hides needs the
// repo's package.json, which only exists here. The sandbox receives the port
// already baked in.

import { prisma } from "@nexux/db";
import { safeSlug } from "@nexux/sandbox";

import { nodePorts, resolveNodeDir, resolveScriptCommand } from "./node-runtime";
import { nodePhases, runPhases, servicePhases } from "./phases";
import type { PhaseSource } from "./phases";
import type { PortMapping, StackPhase } from "./types";

/** A command a sandbox can start, with everything needed to start it. */
export type SandboxProcessPlan = {
  /** Stable across restarts: `<nodeId>#<i>` or `repo-<repositoryId>`. */
  key: string;
  label: string;
  repositoryId: string | null;
  command: string;
  /** Absolute remote directory the command runs in. */
  cwd: string;
  port: number | null;
  /**
   * Every port liveness may probe. `port` stays null for a launcher (its shell
   * exits by design, so the HTTP wait would only time out), but its declared
   * ports are still the honest way to ask "are the services it started up".
   */
  checkPorts: number[];
  /** `run` boots the app; `services` brings infrastructure up. */
  role: "run" | "services";
  /** Where the plan came from, for UI attribution. */
  source: "stack" | "repo-setup";
};

/** Remote checkout of a repo — mirrors what renderRepoSection clones to. */
const remoteRepoDir = (name: string) => `/opt/nexus/${safeSlug(name)}`;

/** The node fields plan-building needs — a subset of the Prisma row. */
export type ProcessNodeSource = PhaseSource & {
  id: string;
  name: string;
  ports?: unknown;
  phases?: unknown;
  repository: { id: string; name: string; localPath: string | null } | null;
};

/** The repo fields plan-building needs. */
export type ProcessRepoSource = {
  id: string;
  name: string;
  localPath: string | null;
  setup: { runCommand: string | null } | null;
};

/**
 * Resolve `pnpm dev` to the script it hides, so a port declared only inside the
 * repo's package.json still reaches the sandbox. Injectable so the rule can be
 * tested without a checkout on disk.
 */
export type ScriptResolver = (
  command: string,
  dir: string | null,
) => Promise<string | null>;

/**
 * A phase's remote cwd: the repo checkout, plus the phase's (or node's)
 * workdir. Leading "./" is stripped the same way serviceLaunchers does it.
 */
function remoteDir(base: string, workdir: string | null | undefined): string {
  const rel = (workdir ?? "").replace(/^\.\/?/, "").trim();
  return rel ? `${base}/${rel}` : base;
}

/**
 * Every process this project's sandboxes can run, in canvas order.
 *
 * Keys are deterministic — restarting a process reuses its row rather than
 * orphaning a PID file, and a canvas edit only invalidates the entries it
 * actually changed.
 */
export async function getSandboxProcessPlans(
  projectId: string,
): Promise<SandboxProcessPlan[]> {
  const [nodes, repos] = await Promise.all([
    // Prisma types the Json columns as JsonValue; buildProcessPlans reads them
    // through the same `unknown` seam every other phases reader uses.
    prisma.stackNode.findMany({
      where: { projectId },
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        kind: true,
        name: true,
        runMode: true,
        image: true,
        command: true,
        installCommand: true,
        buildCommand: true,
        localCommand: true,
        stopCommand: true,
        managesServices: true,
        workdir: true,
        ports: true,
        detection: true,
        phases: true,
        repository: { select: { id: true, name: true, localPath: true } },
      },
    }),
    prisma.repository.findMany({
      where: { projectId },
      orderBy: [{ isMain: "desc" }, { createdAt: "asc" }],
      include: { setup: true },
    }),
  ]);

  return buildProcessPlans(nodes, repos);
}

/**
 * The plan-building rule itself, free of prisma so it can be exercised
 * directly. `resolveScript` reads a repo's package.json by default.
 */
export async function buildProcessPlans(
  nodes: ProcessNodeSource[],
  repos: ProcessRepoSource[],
  resolveScript: ScriptResolver = resolveScriptCommand,
): Promise<SandboxProcessPlan[]> {
  const plans: SandboxProcessPlan[] = [];
  // Repos already covered by a canvas node must not get a duplicate plan from
  // their RepositorySetup — the canvas is the better answer.
  const claimed = new Set<string>();

  for (const node of nodes) {
    if (node.runMode !== "local") continue; // docker nodes belong to compose
    const repo = node.repository;
    if (!repo) continue; // a bare local node has no checkout to run in
    const phases = nodePhases(node);
    // A launcher's `services` phase is startable too: after a pause/resume its
    // containers are gone, and nothing else brings them back.
    const entries: Array<{ phase: StackPhase; role: "run" | "services" }> = [
      ...runPhases(phases).map((phase) => ({ phase, role: "run" as const })),
      ...servicePhases(phases).map((phase) => ({
        phase,
        role: "services" as const,
      })),
    ];
    if (!entries.length) continue;
    claimed.add(repo.id);

    const base = remoteRepoDir(repo.name);
    for (const [i, { phase, role }] of entries.entries()) {
      const command = phase.command!;
      // The port lives in the repo's own script more often than on the node,
      // and only this host can read that script.
      const hostDir = resolveNodeDir(repo.localPath, phase.workdir ?? node.workdir);
      const script = await resolveScript(command, hostDir);
      // Declared ports belong to the node as a whole; only the first run phase
      // may claim them, or two servers would both advertise the same port.
      const declared = i === 0 ? ((node.ports as PortMapping[] | null) ?? null) : null;
      const ports = nodePorts(declared, command, script);
      const port = ports[0] ?? null;
      plans.push({
        key: `${node.id}#${i}`,
        label: entries.length > 1 ? `${node.name} (${i + 1})` : node.name,
        repositoryId: repo.id,
        command,
        cwd: remoteDir(base, phase.workdir ?? node.workdir),
        // A launcher exits once its containers are up, so probing a port would
        // only time out — leave it unset and let the command's exit stand.
        // Its ports still land in checkPorts: they are how liveness can see
        // the containers after that exit.
        port: role === "services" ? null : port,
        checkPorts: ports,
        role,
        source: "stack",
      });
    }
  }

  // Repos the canvas does not describe: their explicit setup command still
  // deserves a start button.
  for (const repo of repos) {
    if (claimed.has(repo.id)) continue;
    const command = repo.setup?.runCommand?.trim();
    if (!command) continue;
    const script = await resolveScript(command, repo.localPath ?? null);
    const ports = nodePorts(null, command, script);
    plans.push({
      key: `repo-${repo.id}`,
      label: repo.name,
      repositoryId: repo.id,
      command,
      cwd: remoteRepoDir(repo.name),
      port: ports[0] ?? null,
      checkPorts: ports,
      role: "run",
      source: "repo-setup",
    });
  }

  return plans;
}
