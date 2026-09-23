// Spec 25, piece 1 — turning detection into a graph.
//
// Detection is good and unused. `detectRepo` finds the Dockerfile, the compose
// file, the package manager, the scripts, the env keys and the exposed ports —
// and parses each Makefile target's recipe, so a `make dev` that is secretly
// `docker compose up -d postgres` is recorded as such. All of it fires only
// when a human drags a repo onto the canvas, and prefills exactly one node.
//
// Nothing turns it into a graph. That is what this does: units in, nodes and
// edges out, with the evidence for every inference attached so the user can
// tell which parts to trust. A generated graph nobody can interrogate is worse
// than no graph.

import type { DetectionResult, PortMapping, StackPhase } from "./types";
import { SERVICE_CATALOG, SERVICE_COMMANDS } from "./service-catalog";
import type { RunnableUnit } from "./units";

export type SeedConfidence = "high" | "low";

export type SeededNode = {
  /** Temporary id; the PUT route assigns the real one. */
  id: string;
  kind: "repo" | "service";
  name: string;
  runMode: "docker" | "local";
  repositoryId: string | null;
  image: string | null;
  dockerfile: string | null;
  workdir: string | null;
  ports: PortMapping[] | null;
  env: Array<{ key: string; value: string }> | null;
  volumes: Array<{ host: string; container: string }> | null;
  command: string | null;
  phases: StackPhase[];
  posX: number;
  posY: number;
  /** How sure we are, and why — rendered in the inspector. */
  confidence: SeedConfidence;
  evidence: string;
};

export type SeededEdge = { sourceId: string; targetId: string };

export type SeedResult = {
  nodes: SeededNode[];
  edges: SeededEdge[];
  /** Things the user should look at before provisioning. */
  notes: string[];
};

export type SeedUnit = {
  unit: RunnableUnit;
  repositoryId: string | null;
  detection: DetectionResult;
};

/**
 * Evidence that a unit depends on a service.
 *
 * **Scheme first, name second.** `DATABASE_URL=postgres://…` names its engine
 * in the URL and is conclusive. `DATABASE_URL` on its own does not — the
 * project may well mean MySQL — so the node is still created but flagged low
 * confidence with the reason attached. The alternative to a low-confidence
 * node is silence, which leaves the blank canvas this piece exists to remove.
 */
const SERVICE_EVIDENCE: Array<{
  catalogKey: string;
  /** Matches a value, and is conclusive when it does. */
  scheme?: RegExp;
  /** Matches a key name, and is suggestive only. */
  keys: RegExp;
}> = [
  {
    catalogKey: "postgres",
    scheme: /^(postgres|postgresql|pgsql):\/\//i,
    keys: /^(POSTGRES_|PG(HOST|PORT|USER|PASSWORD|DATABASE)$)/i,
  },
  {
    catalogKey: "mysql",
    scheme: /^(mysql|mariadb):\/\//i,
    keys: /^(MYSQL_|MARIADB_)/i,
  },
  {
    catalogKey: "redis",
    scheme: /^rediss?:\/\//i,
    keys: /^REDIS_(URL|HOST|PORT|PASSWORD)$/i,
  },
  {
    catalogKey: "mongo",
    scheme: /^mongodb(\+srv)?:\/\//i,
    keys: /^(MONGO_|MONGODB_)/i,
  },
  {
    catalogKey: "minio",
    keys: /^(MINIO_|S3_(ENDPOINT|BUCKET))/i,
  },
  {
    catalogKey: "ollama",
    keys: /^OLLAMA_(HOST|URL|BASE_URL)$/i,
  },
];

/**
 * A key that names a database without naming which one.
 *
 * Only used to word the evidence: a low-confidence postgres from
 * `DATABASE_URL` deserves a different sentence from one guessed off
 * `POSTGRES_HOST`, because the first is genuinely ambiguous and the second is
 * merely unconfirmed.
 */
const AMBIGUOUS_KEY = /^(DATABASE_URL|DB_URL|DATABASE_URI)$/i;

/**
 * Whether a unit is worth a node.
 *
 * A workspace of nine libraries and two apps must not become eleven nodes: a
 * unit earns one only if it has something to *run* — a dev/start script, a
 * Dockerfile, or a Makefile target detection flagged. A package with only
 * `build` and `test` is a library; it is built by its dependents' install and
 * has no place on a canvas that describes what boots.
 */
export function isRunnable(detection: DetectionResult): boolean {
  return Boolean(
    detection.suggestedCommands.dev ||
      detection.suggestedCommands.start ||
      detection.hasDockerfile ||
      detection.makeTargetDetails?.some((t) => t.usesDocker && t.detached),
  );
}

function phasesFor(detection: DetectionResult, workdir: string): StackPhase[] {
  const phases: StackPhase[] = [];
  const dir = workdir || null;
  const { install, build, dev, start } = detection.suggestedCommands;

  if (install) {
    phases.push({ role: "install", exec: "host", command: install, workdir: dir });
  }
  if (build) {
    phases.push({ role: "build", exec: "host", command: build, workdir: dir });
  }

  // A Makefile target that drives docker and returns is a services phase, not
  // a run phase — the shape spec 17 defined and that detection already fills
  // but nothing ever wrote.
  const launcher = detection.makeTargetDetails?.find(
    (t) => t.usesDocker && t.detached && !t.teardown,
  );
  if (launcher) {
    phases.push({
      role: "services",
      exec: "compose-extern",
      command: `make ${launcher.name}`,
      composePath: launcher.composeFiles[0] ?? detection.composePath ?? null,
      provides: launcher.composeServices.length ? launcher.composeServices : undefined,
      detached: true,
      workdir: dir,
    });
  }

  const run = dev ?? start;
  if (run) {
    phases.push({ role: "run", exec: "host", command: run, workdir: dir });
  }
  return phases;
}

function portsFor(detection: DetectionResult): PortMapping[] | null {
  const port = detection.suggestedPorts[0];
  return port ? [{ host: port, container: port }] : null;
}

/**
 * Builds the starting graph.
 *
 * Pure: every unit arrives with its detection already done, so this is
 * testable without a filesystem and the same function serves the API route and
 * the tests.
 */
export function seedStack(units: SeedUnit[]): SeedResult {
  const nodes: SeededNode[] = [];
  const edges: SeededEdge[] = [];
  const notes: string[] = [];

  // A workspace member does not declare its own package manager — the root
  // does, in `packageManager`, and detection scans each unit in isolation so
  // it cannot see it. Left alone, a pnpm monorepo's apps each get `npm
  // install`, which in the best case ignores the workspace and in the worst
  // writes a package-lock.json beside a pnpm-lock.yaml.
  //
  // The root's answer wins for its own members, and only when the member had
  // nothing better to say: a unit that ships its own lockfile keeps it.
  const rootManager = units.find(
    (u) => u.unit.isRoot && u.detection.packageManager,
  )?.detection.packageManager;

  // --- run nodes, one per runnable unit -----------------------------------

  const runNodes: Array<{ node: SeededNode; entry: SeedUnit }> = [];
  for (const rawEntry of units) {
    const entry = inheritManager(rawEntry, rootManager);
    const { unit, detection } = entry;
    if (!isRunnable(detection)) {
      // The root of a workspace usually is not runnable itself; saying so for
      // every library would be noise.
      if (!unit.isRoot) {
        notes.push(`"${unit.name}" has nothing to run — treated as a library.`);
      }
      continue;
    }

    const node: SeededNode = {
      id: `tmp-${unit.workdir ? unit.workdir.replace(/\//g, "-") : "root"}-${runNodes.length}`,
      kind: "repo",
      name: unit.name,
      // The rule the canvas already applies when a repo is dropped on it.
      runMode: detection.hasDockerfile ? "docker" : "local",
      repositoryId: entry.repositoryId,
      image: null,
      dockerfile: detection.dockerfilePath ?? null,
      workdir: unit.workdir || null,
      ports: portsFor(detection),
      env: null,
      volumes: null,
      command: null,
      phases: phasesFor(detection, unit.workdir),
      posX: 0,
      posY: 0,
      confidence: "high",
      evidence: detection.hasDockerfile
        ? `Dockerfile at ${detection.dockerfilePath}`
        : `${detection.packageManager ?? "npm"} scripts in package.json`,
    };
    nodes.push(node);
    runNodes.push({ node, entry });
  }

  // --- inferred services --------------------------------------------------

  // A repo that owns a compose file has already declared its services;
  // inferring more would start a second postgres fighting over 5432.
  const ownsCompose = units.some((u) => u.detection.hasCompose);
  if (ownsCompose) {
    notes.push(
      "A repository ships its own compose file — services were not inferred, so the two cannot fight over the same ports.",
    );
  }

  // One service per project, not per unit: three units naming DATABASE_URL
  // want one postgres between them.
  const serviceNodes = new Map<string, SeededNode>();
  const dependents = new Map<string, Set<string>>();

  if (!ownsCompose) {
    for (const { node: runNode, entry } of runNodes) {
      const { detection, unit } = entry;
      const values = detection.envExampleValues ?? {};

      for (const key of detection.envExampleKeys) {
        const value = values[key] ?? "";
        for (const rule of SERVICE_EVIDENCE) {
          // The value naming its own engine is conclusive wherever it appears:
          // `DATABASE_URL=postgres://…` and `CACHE=redis://…` are both proof.
          const byScheme = rule.scheme?.test(value) ?? false;
          const byKey = rule.keys.test(key);
          if (!byScheme && !byKey) continue;
          const conclusive = byScheme;
          const def = SERVICE_CATALOG.find((s) => s.key === rule.catalogKey);
          if (!def) continue;

          let service = serviceNodes.get(rule.catalogKey);
          if (!service) {
            service = {
              id: `tmp-svc-${rule.catalogKey}`,
              kind: "service",
              name: def.name.toLowerCase(),
              runMode: "docker",
              repositoryId: null,
              image: def.image,
              dockerfile: null,
              workdir: null,
              ports: def.ports,
              env: def.env,
              volumes: def.volumes,
              command: SERVICE_COMMANDS[def.key] ?? null,
              phases: [
                {
                  role: "services",
                  exec: "compose",
                  command: null,
                  image: def.image,
                  detached: true,
                },
              ],
              posX: 0,
              posY: 0,
              confidence: conclusive ? "high" : "low",
              evidence: conclusive
                ? `${key}=${value.slice(0, 40)} in ${unit.name}`
                : AMBIGUOUS_KEY.test(key)
                  ? `${key} in ${unit.name} does not say which engine`
                  : `${key} in ${unit.name}`,
            };
            serviceNodes.set(rule.catalogKey, service);
            nodes.push(service);
          } else if (conclusive && service.confidence === "low") {
            // A later unit proved what an earlier one only hinted at.
            service.confidence = "high";
            service.evidence = `${key}=${value.slice(0, 40)} in ${unit.name}`;
          }

          const set = dependents.get(service.id) ?? new Set<string>();
          set.add(runNode.id);
          dependents.set(service.id, set);
          break; // one service per key
        }
      }
    }
  }

  // --- edges --------------------------------------------------------------

  // A unit depends on a service when the evidence that created it came from
  // that unit's own example file. That is a fact, not a guess.
  //
  // Unit-to-unit edges are NOT inferred. A front end's API_URL pointing at
  // localhost:8000 and a back end exposing 8000 is suggestive, not conclusive,
  // and a wrong edge changes boot order in a way that is hard to debug. Two
  // apps in one git are no more related than two gits — treating co-location
  // as evidence is exactly the wrong inference.
  for (const [serviceId, sources] of dependents) {
    for (const sourceId of sources) {
      edges.push({ sourceId, targetId: serviceId });
    }
  }

  // --- collisions ---------------------------------------------------------

  // Two apps in one workspace both defaulting to 3000 is common, and is a boot
  // failure a validation would catch three minutes later. Flagged now,
  // unresolved on purpose: picking a port changes the URL the user expects.
  const byPort = new Map<number, string[]>();
  for (const node of nodes) {
    for (const p of node.ports ?? []) {
      byPort.set(p.host, [...(byPort.get(p.host) ?? []), node.name]);
    }
  }
  for (const [port, owners] of [...byPort].sort((a, b) => a[0] - b[0])) {
    if (owners.length < 2) continue;
    notes.push(
      `Port ${port} is claimed by ${owners.map((o) => `"${o}"`).join(" and ")} — change one before starting them together.`,
    );
  }

  return { nodes: layout(nodes), edges, notes };
}

/**
 * Left-to-right: apps in a row, services beneath them.
 *
 * Not cosmetic — a seeded canvas where every node sits at (0,0) reads as a
 * single node and hides most of what was inferred.
 */
function layout(nodes: SeededNode[]): SeededNode[] {
  let app = 0;
  let svc = 0;
  for (const node of nodes) {
    if (node.kind === "repo") {
      node.posX = app++ * 280;
      node.posY = 0;
    } else {
      node.posX = svc++ * 280;
      node.posY = 220;
    }
  }
  return nodes;
}


/**
 * Rewrites a member unit's commands to use the workspace's package manager.
 *
 * Only the verb changes — `npm run dev` becomes `pnpm dev`, the script name is
 * the unit's own. A unit that detected its own manager (it has a lockfile) is
 * left alone, and so is the root.
 */
function inheritManager(
  entry: SeedUnit,
  rootManager: DetectionResult["packageManager"] | undefined,
): SeedUnit {
  const { detection, unit } = entry;
  if (
    unit.isRoot ||
    !rootManager ||
    rootManager === "npm" ||
    detection.packageManager === rootManager
  ) {
    return entry;
  }

  const rewrite = (command: string | undefined): string | undefined => {
    if (!command) return command;
    return command
      .replace(/^npm run\s+/, `${rootManager} `)
      .replace(/^npm\s+(install|ci)\b/, `${rootManager} install`)
      .replace(/^npm\s+start\b/, `${rootManager} start`);
  };

  return {
    ...entry,
    detection: {
      ...detection,
      packageManager: rootManager,
      suggestedCommands: {
        install: rewrite(detection.suggestedCommands.install),
        build: rewrite(detection.suggestedCommands.build),
        dev: rewrite(detection.suggestedCommands.dev),
        start: rewrite(detection.suggestedCommands.start),
      },
    },
  };
}
