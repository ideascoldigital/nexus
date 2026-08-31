// A node's phases: what it does, in order, and what executes each step.
// See spec 17 / D-20.
//
// Phases are the source of truth (`nodePhases` reads the persisted column), but
// the legacy command columns are still written from them via `columnsOf` so a
// rollback — or a reader not yet migrated — sees a coherent node. Rows written
// before the cutover hold no phases and are derived from the columns instead,
// which is what every reader did before persistence existed.
//
// Client-safe: pure, no node builtins.

import type {
  DetectionResult,
  ExecKind,
  MakeTarget,
  PhaseRole,
  StackPhase,
} from "./types";

/** The node fields a derivation needs — a structural subset of both the DTO
 *  and the Prisma row, so callers can pass either. */
export type PhaseSource = {
  kind: string;
  runMode: string;
  image?: string | null;
  command?: string | null;
  installCommand?: string | null;
  buildCommand?: string | null;
  localCommand?: string | null;
  stopCommand?: string | null;
  managesServices?: boolean;
  workdir?: string | null;
  detection?: unknown;
};

const clean = (value: string | null | undefined): string | null =>
  value?.trim() || null;

/**
 * The `make` target a command invokes, as detection understood it. A target's
 * name says nothing on its own — `make dev` may well be `docker compose up`,
 * and only the scanned recipe knows.
 */
export function makeTargetOf(
  command: string | null | undefined,
  detection: unknown
): MakeTarget | null {
  const name = /^\s*make\s+([\w.\/-]+)\s*$/.exec(command ?? "")?.[1];
  if (!name) return null;
  const details = (detection as DetectionResult | null)?.makeTargetDetails;
  return details?.find((t) => t.name === name) ?? null;
}

/** A command that drives compose directly, without going through make. */
const DIRECT_COMPOSE_RE = /\b(?:docker|podman)[\s-]compose\b/;

/**
 * What runs a local command: a compose file the repo owns, or the host itself.
 * Only commands that *delegate to compose* count as compose-extern — a plain
 * `pnpm dev` is a host process even on a node full of docker siblings.
 */
function localExec(
  command: string | null,
  target: MakeTarget | null
): ExecKind {
  if (!command) return "host";
  if (target?.usesDocker) {
    return target.composeFiles.length ||
      target.composeServices.length ||
      DIRECT_COMPOSE_RE.test(command)
      ? "compose-extern"
      : "container";
  }
  return DIRECT_COMPOSE_RE.test(command) ? "compose-extern" : "host";
}

/**
 * A node's phases, in the order they run.
 *
 * Docker nodes are a single `services` phase — compose owns them end to end.
 * Local nodes split into install → build → services/run → stop, where the
 * middle phase's role comes from `managesServices`: a launcher provides
 * services, anything else runs the app.
 */
export function phasesOf(node: PhaseSource): StackPhase[] {
  const workdir = clean(node.workdir);

  if (node.runMode === "docker") {
    return [
      {
        role: "services",
        exec: "compose",
        command: clean(node.command),
        image: clean(node.image),
        detached: true,
        workdir,
      },
    ];
  }

  const phases: StackPhase[] = [];
  const push = (
    role: StackPhase["role"],
    command: string | null,
    exec: ExecKind,
    extra: Partial<StackPhase> = {}
  ) => {
    if (!command) return;
    phases.push({ role, exec, command, workdir, ...extra });
  };

  // Install and build are host steps by definition — they prepare a checkout,
  // they do not run it. (Today only the sandbox executes them; see spec 17.)
  push("install", clean(node.installCommand), "host");
  push("build", clean(node.buildCommand), "host");

  const command = clean(node.localCommand);
  const target = makeTargetOf(command, node.detection);
  const exec = localExec(command, target);
  // A launcher starts infrastructure; everything else starts the app itself.
  const role = node.managesServices ? "services" : "run";
  push(role, command, exec, {
    // `managesServices` is the user's explicit answer and outranks detection;
    // a recipe that exits on its own is the fallback for nodes never marked.
    detached: node.managesServices || target?.detached || undefined,
    composePath: target?.composeFiles[0] ?? undefined,
    provides: target?.composeServices.length
      ? target.composeServices
      : undefined,
  });

  const stop = clean(node.stopCommand);
  const stopTarget = makeTargetOf(stop, node.detection);
  push("stop", stop, localExec(stop, stopTarget), {
    composePath: stopTarget?.composeFiles[0] ?? undefined,
  });

  return phases;
}

const ROLES: PhaseRole[] = ["install", "build", "services", "run", "stop"];
const EXECS: ExecKind[] = ["host", "compose", "compose-extern", "container"];

/**
 * Validate a persisted `phases` value. Anything malformed answers null so the
 * caller falls back to deriving — a bad JSON blob must not blank out a node.
 */
export function parsePhases(value: unknown): StackPhase[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const phases: StackPhase[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object") return null;
    const p = raw as Record<string, unknown>;
    if (!ROLES.includes(p.role as PhaseRole)) return null;
    if (!EXECS.includes(p.exec as ExecKind)) return null;
    const str = (key: string): string | null | undefined =>
      p[key] === null || p[key] === undefined
        ? (p[key] as null | undefined)
        : typeof p[key] === "string"
          ? (p[key] as string)
          : undefined;
    if (p.command !== null && typeof p.command !== "string") return null;
    phases.push({
      role: p.role as PhaseRole,
      exec: p.exec as ExecKind,
      command: clean(p.command as string | null),
      ...(str("image") !== undefined ? { image: clean(str("image")) } : {}),
      ...(str("composePath") !== undefined
        ? { composePath: clean(str("composePath")) }
        : {}),
      ...(Array.isArray(p.provides)
        ? { provides: p.provides.filter((s): s is string => typeof s === "string") }
        : {}),
      ...(typeof p.detached === "boolean" ? { detached: p.detached } : {}),
      ...(str("workdir") !== undefined ? { workdir: clean(str("workdir")) } : {}),
    });
  }
  return phases;
}

/**
 * A node's phases: what was persisted, or derived from the columns when the
 * row predates the cutover (or holds something unreadable).
 */
export function nodePhases(
  node: PhaseSource & { phases?: unknown }
): StackPhase[] {
  return parsePhases(node.phases) ?? phasesOf(node);
}

/**
 * The command columns implied by a set of phases. Phases are the source of
 * truth; these are written alongside them so a rollback — or any reader not yet
 * migrated — still sees a coherent node.
 */
export function columnsOf(phases: StackPhase[]): {
  runMode: "docker" | "local";
  installCommand: string | null;
  buildCommand: string | null;
  localCommand: string | null;
  stopCommand: string | null;
  managesServices: boolean;
} {
  // A role can repeat — two `services` phases bringing up different stacks is
  // a legitimate node. One column cannot hold two commands, so they collapse
  // into a single shell sequence: `&&`, since a step whose predecessor failed
  // has nothing to run against. Phases stay the real answer; this is only what
  // the compatibility column can express.
  const commandOf = (role: PhaseRole) => {
    const commands = commandsOf(phases, role);
    return commands.length ? commands.join(" && ") : null;
  };
  const services = commandOf("services");
  // A node whose only phase is compose-owned is a docker node; anything with
  // work of its own to run on the host is local.
  const isDocker =
    phases.length > 0 && phases.every((p) => p.exec === "compose");
  return {
    runMode: isDocker ? "docker" : "local",
    installCommand: commandOf("install"),
    buildCommand: commandOf("build"),
    // A launcher's command lived in localCommand next to managesServices.
    localCommand: commandOf("run") ?? (isDocker ? null : services),
    stopCommand: commandOf("stop"),
    managesServices: !isDocker && !!services,
  };
}

/** Every phase of a role, in order. A role may legitimately repeat. */
export const phasesWithRole = (
  phases: StackPhase[],
  role: PhaseRole
): StackPhase[] => phases.filter((p) => p.role === role);

/** Every non-empty command of a role, in order. */
export const commandsOf = (
  phases: StackPhase[],
  role: PhaseRole
): string[] =>
  phasesWithRole(phases, role)
    .map((p) => clean(p.command))
    .filter((c): c is string => c !== null);

/**
 * The phases that boot this node. A node may declare more than one — two
 * servers from one checkout — so callers that can run several should use this
 * over `runPhase`.
 */
export const runPhases = (phases: StackPhase[]): StackPhase[] =>
  phasesWithRole(phases, "run").filter((p) => clean(p.command));

/**
 * The first phase that boots this node. For the callers that genuinely need a
 * single answer — a sandbox has one preview port, not several.
 */
export const runPhase = (phases: StackPhase[]): StackPhase | null =>
  runPhases(phases)[0] ?? null;

/** Phases that bring infrastructure up rather than the app. */
export const servicePhases = (phases: StackPhase[]): StackPhase[] =>
  phasesWithRole(phases, "services").filter((p) => clean(p.command));

/**
 * True when any phase needs a container runtime. Replaces the old reading of
 * `runMode === "docker" || managesServices`, which missed a `make dev` whose
 * recipe is `docker compose up` — nothing on the node said so.
 */
export const needsContainerRuntime = (phases: StackPhase[]): boolean =>
  phases.some((p) => p.exec !== "host");
