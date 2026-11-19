// What a sandbox inherits from the Stack canvas.
//
// The stack already describes how a project runs: which command boots the app,
// on which port, and whether anything needs Docker. Sandboxes used to re-state
// all of that in SandboxConfig / RepositorySetup, so the two drifted — a stack
// node saying `pnpm dev --port 3003` while the sandbox previewed port 3000.
//
// The stack is the source of truth here; SandboxConfig keeps only what is
// genuinely sandbox-specific (provider, region, size, credentials, agent
// policy). Explicit sandbox values still win — inheritance fills the blanks,
// it never overrides a deliberate choice.

import { prisma } from "@nexux/db";

import { nodePorts, resolveNodeDir, resolveScriptCommand } from "./node-runtime";
import {
  commandsOf,
  needsContainerRuntime,
  nodePhases,
  runPhase,
  servicePhases,
} from "./phases";
import type { PortMapping, StackInheritance, StackPhase } from "./types";

const EMPTY: StackInheritance = {
  appName: null,
  runCommand: null,
  previewPort: null,
  needsDocker: false,
  serviceLaunchers: [],
  repoCommands: [],
  notes: [],
};

/**
 * Read the stack graph and derive the sandbox-relevant facts.
 *
 * The "main" app node is the local repo node that is not a service launcher —
 * a launcher starts infrastructure, not the app under review. Ties break
 * towards the project's main repository.
 */
export async function getStackInheritance(
  projectId: string
): Promise<StackInheritance> {
  const nodes = await prisma.stackNode.findMany({
    where: { projectId },
    select: {
      id: true,
      kind: true,
      name: true,
      runMode: true,
      installCommand: true,
      buildCommand: true,
      localCommand: true,
      stopCommand: true,
      managesServices: true,
      workdir: true,
      ports: true,
      detection: true,
      phases: true,
      repository: {
        select: { id: true, name: true, localPath: true, isMain: true },
      },
    },
  });
  if (!nodes.length) return EMPTY;

  const notes: string[] = [];
  // Phases say what each command does and what executes it, which the columns
  // alone do not. Persisted since spec 17 step 2; derived for older rows.
  const phasesByNode = new Map<string, StackPhase[]>(
    nodes.map((n) => [n.id, nodePhases(n)])
  );
  const localNodes = nodes.filter((n) => n.runMode === "local");
  const phasesOfNode = (nodeId: string) => phasesByNode.get(nodeId) ?? [];

  // A local node can need Docker without anyone saying so: `make dev` whose
  // recipe is `docker compose up` looks like a plain command on the canvas.
  // Detection read that recipe, so the phase carries it and a sandbox gets
  // Docker installed either way.
  const needsDocker = nodes.some((n) => needsContainerRuntime(phasesOfNode(n.id)));

  for (const n of localNodes) {
    if (n.managesServices) continue;
    const run = runPhase(phasesOfNode(n.id));
    if (!run || run.exec === "host") continue;
    notes.push(
      `"${n.name}" runs \`${run.command}\`, which drives Docker — the sandbox installs it.`
    );
  }

  // One entry per service phase: a node may bring up more than one stack, and
  // dropping the extras would leave the sandbox missing infrastructure.
  const serviceLaunchers = localNodes.flatMap((n) => {
    const phases = phasesOfNode(n.id);
    const launchers = servicePhases(phases);
    // The teardowns pair with the launchers by position where they can; a
    // single stop phase is taken to undo whatever the node started.
    const stops = commandsOf(phases, "stop");
    return launchers.map((services, i) => ({
      name: launchers.length > 1 ? `${n.name} (${i + 1})` : n.name,
      repoName: n.repository?.name ?? null,
      workdir: (services.workdir ?? n.workdir ?? "").replace(/^\.\/?/, ""),
      startCommand: services.command!,
      stopCommand: (stops.length === 1 ? stops[0] : stops[i]) ?? null,
    }));
  });

  // Every local repo node with a command — the canvas is a better answer than
  // a generic "pnpm start" guess, for the app and for launchers alike.
  const repoCommands = await Promise.all(localNodes.map(async (n) => {
    if (!n.repository?.id) return [];
    const phases = phasesOfNode(n.id);
    // A repo's bootstrap has one slot per step, so a repeated role collapses
    // into a single `&&` sequence — the same compromise `columnsOf` makes.
    const commandOf = (role: StackPhase["role"]) => {
      const commands = commandsOf(phases, role);
      return commands.length ? commands.join(" && ") : null;
    };
    // A launcher's command boots services, not the repo — it still belongs
    // here, flagged, because the bootstrap has to run it.
    const runCommand = commandOf("run") ?? commandOf("services");
    const installCommand = commandOf("install");
    const buildCommand = commandOf("build");
    if (!runCommand && !installCommand && !buildCommand) return [];
    // The port this repo's run command serves, resolved the same way the app
    // node's is — the sandbox needs it per repo, not just for the one node
    // that drives the preview, so a second service can be boot-probed too
    // (spec 24 piece 2). Null when the node declares none and the command
    // does not reveal one; the bootstrap then skips the probe rather than
    // guessing a port.
    const runPort = runCommand
      ? nodePorts(
          n.ports as PortMapping[] | null,
          runCommand,
          await resolveScriptCommand(
            runCommand,
            resolveNodeDir(n.repository?.localPath, n.workdir),
          ),
        )[0] ?? null
      : null;
    return [
      {
        repositoryId: n.repository.id,
        nodeName: n.name,
        installCommand,
        buildCommand,
        runCommand,
        runPort,
        managesServices: n.managesServices,
      },
    ];
  })).then((r) => r.flat());

  // The app node: a local repo node with a phase that boots the app. A
  // launcher has a `services` phase instead, so it never qualifies.
  const appCandidates = localNodes.filter(
    (n) => n.kind === "repo" && runPhase(phasesOfNode(n.id))?.command
  );
  const app =
    appCandidates.find((n) => n.repository?.isMain) ?? appCandidates[0] ?? null;

  if (!app) {
    if (localNodes.length) {
      notes.push(
        "No app node on the canvas — add a repo in local mode with a dev command to drive the sandbox preview."
      );
    }
    return { ...EMPTY, needsDocker, serviceLaunchers, repoCommands, notes };
  }

  const runCommand = runPhase(phasesOfNode(app.id))!.command!;
  // Resolving `pnpm dev` to the underlying script reads the repo's
  // package.json, which only exists on this host — a sandbox gets the port
  // baked in at dispatch time instead of re-deriving it remotely.
  const dir = resolveNodeDir(app.repository?.localPath, app.workdir);
  const script = await resolveScriptCommand(runCommand, dir);
  const previewPort = nodePorts(app.ports, runCommand, script)[0] ?? null;

  if (!previewPort) {
    notes.push(
      `Could not tell which port "${app.name}" serves — declare one on the node to drive the live preview.`
    );
  }

  return {
    appName: app.name,
    runCommand,
    previewPort,
    needsDocker,
    serviceLaunchers,
    repoCommands,
    notes,
  };
}
