// Spec 24, piece 4 — the questions a stack definition can be asked before
// anything is provisioned.
//
// This is the static half. It cannot tell you the app boots — only a real run
// does that, which is what the bootstrap's `boot:*` steps (piece 2) record —
// but it catches the definition mistakes that would otherwise be discovered
// twenty minutes into a provision, or, worse, not discovered: the compose
// generator's warnings were the only pre-flight, and they only ever answered
// questions about the YAML it was about to emit.
//
// Every finding names the node it is about and says what to do. A validator
// that reports "invalid" without saying which node and why is a slower way of
// reading the canvas yourself.

import { healthcheckFor } from "@nexux/harness";

import { nodePhases } from "./phases";
import type {
  PortMapping,
  StackNodeDTO,
  StackPhase,
  ValidationFinding,
  ValidationSeverity,
} from "./types";

export type { ValidationFinding, ValidationSeverity };

export type ValidationInput = {
  nodes: StackNodeDTO[];
  edges: Array<{ sourceId: string; targetId: string }>;
  /** Repo id → whether the repo has a local checkout we could read. */
  repoHasLocalPath?: Map<string, boolean>;
};

export type ValidationResult = {
  findings: ValidationFinding[];
  /** No errors. Warnings do not make a stack invalid — they make it risky. */
  ok: boolean;
};

/** Ports a node publishes on the host, from its declared mappings. */
function hostPorts(node: StackNodeDTO): number[] {
  return ((node.ports as PortMapping[] | null) ?? [])
    .map((p) => p?.host)
    .filter((p): p is number => typeof p === "number" && p > 0);
}

function runnablePhases(node: StackNodeDTO): StackPhase[] {
  return nodePhases(node).filter((p) => p.role === "run" && p.command);
}

/**
 * Checks that need no filesystem, no docker and no network.
 *
 * Ordered by how early they would otherwise bite: a graph that cannot be
 * expressed at all, then a node that cannot start, then one that will collide,
 * then the things that merely make a provision slower or less certain.
 */
export function validateStack(input: ValidationInput): ValidationResult {
  const findings: ValidationFinding[] = [];
  const { nodes, edges } = input;
  const byId = new Map(nodes.map((n) => [n.id, n]));

  const at = (
    node: StackNodeDTO | null,
    rule: string,
    severity: ValidationSeverity,
    message: string,
    fix?: string,
  ) =>
    findings.push({
      rule,
      severity,
      nodeId: node?.id ?? null,
      nodeName: node?.name ?? null,
      message,
      ...(fix ? { fix } : {}),
    });

  if (nodes.length === 0) {
    at(
      null,
      "empty-canvas",
      "error",
      "The canvas is empty — there is nothing to validate.",
      "Drag a repository in from the sidebar, or use the stack assistant.",
    );
    return { findings, ok: false };
  }

  // --- the graph itself ---------------------------------------------------

  const cyclePath = findCycle(edges);
  if (cyclePath) {
    const names = cyclePath
      .map((id) => byId.get(id)?.name ?? id)
      .join(" → ");
    at(
      null,
      "dependency-cycle",
      "error",
      `Dependency cycle: ${names}. Nothing can start first, so start order is undefined.`,
      "Remove one of those edges.",
    );
  }

  for (const edge of edges) {
    if (!byId.has(edge.sourceId) || !byId.has(edge.targetId)) {
      at(
        null,
        "dangling-edge",
        "warning",
        "An edge points at a node that is no longer on the canvas.",
        "Re-save the canvas to drop it.",
      );
      break; // one is enough; they all have the same fix
    }
  }

  // --- can each node start? ----------------------------------------------

  for (const node of nodes) {
    const phases = nodePhases(node);

    if (node.kind === "service") {
      if (!node.image?.trim()) {
        at(
          node,
          "service-without-image",
          "error",
          `"${node.name}" is a service with no image, so compose has nothing to run.`,
          "Set an image, or delete the node.",
        );
      } else if (!node.image.includes(":") && !node.image.includes("@")) {
        at(
          node,
          "untagged-image",
          "warning",
          `"${node.name}" uses ${node.image} with no tag, which resolves to :latest.`,
          "Pin a tag so a rebuild does not silently change versions.",
        );
      }
      continue;
    }

    // repo nodes
    if (node.runMode === "docker") {
      if (!node.dockerfile?.trim() && !node.image?.trim()) {
        at(
          node,
          "docker-repo-without-build",
          "error",
          `"${node.name}" runs in Docker but declares neither a Dockerfile nor an image.`,
          "Point it at a Dockerfile, or switch it to local mode.",
        );
      }
    } else if (runnablePhases(node).length === 0 && !hasServicePhase(phases)) {
      // A repo with no way to start is not necessarily wrong — it may be a
      // library another node builds — but it cannot be previewed or probed,
      // and saying so is cheaper than wondering why the preview is empty.
      at(
        node,
        "no-run-command",
        "info",
        `"${node.name}" has no run command, so it is never started.`,
        "Add one if this is an app rather than a library.",
      );
    }

    if (node.repositoryId && input.repoHasLocalPath?.get(node.repositoryId) === false) {
      at(
        node,
        "repo-without-local-path",
        "warning",
        `"${node.name}" has no local checkout on this machine.`,
        "Local Up cannot run it; a sandbox clones it from its URL instead.",
      );
    }
  }

  // --- will they collide? -------------------------------------------------

  const portOwners = new Map<number, StackNodeDTO[]>();
  for (const node of nodes) {
    for (const port of hostPorts(node)) {
      portOwners.set(port, [...(portOwners.get(port) ?? []), node]);
    }
  }
  for (const [port, owners] of [...portOwners].sort((a, b) => a[0] - b[0])) {
    if (owners.length < 2) continue;
    at(
      owners[0],
      "port-collision",
      "error",
      `Port ${port} is published by ${owners.map((o) => `"${o.name}"`).join(" and ")}. Only the first to bind will start.`,
      // Deliberately not resolved for them: picking a port changes the URL
      // they expect, and the right answer depends on which one is "the" app.
      "Change one of them.",
    );
  }

  // --- will the provision be certain? ------------------------------------

  for (const node of nodes) {
    if (node.kind !== "service" || !node.image?.trim()) continue;
    if (healthcheckFor(node.image)) continue;
    // Not an error: an unrecognized image is often perfectly fine. But the
    // bootstrap's `--wait` cannot tell "ready" from "running" for it, so a
    // dependent that installs against it may race — which is the exact bug
    // piece 2 removed for the images we do know.
    const dependents = edges
      .filter((e) => e.targetId === node.id)
      .map((e) => byId.get(e.sourceId)?.name)
      .filter(Boolean);
    if (dependents.length === 0) continue;
    at(
      node,
      "unprobeable-dependency",
      "warning",
      `Nothing can tell when "${node.name}" is ready, so ${dependents.map((d) => `"${d}"`).join(", ")} may start against it too early.`,
      "Add a healthcheck to the node, or expect an occasional race on first boot.",
    );
  }

  // Env values that are obviously placeholders: these reach a repo's .env
  // verbatim, and a connection string with CHANGEME in it fails at runtime
  // with an error about credentials rather than about configuration.
  for (const node of nodes) {
    for (const entry of node.env ?? []) {
      if (!entry?.key) continue;
      const value = String(entry.value ?? "");
      if (!/^(|CHANGEME|TODO|xxx+|<[^>]+>)$/i.test(value.trim())) continue;
      at(
        node,
        "placeholder-env",
        value.trim() === "" ? "info" : "warning",
        value.trim() === ""
          ? `"${node.name}" declares ${entry.key} with no value.`
          : `"${node.name}" declares ${entry.key}=${value}, which looks like a placeholder.`,
        "Set it before provisioning, or the app will fail at runtime rather than here.",
      );
    }
  }

  return { findings, ok: !findings.some((f) => f.severity === "error") };
}

function hasServicePhase(phases: StackPhase[]): boolean {
  return phases.some((p) => p.role === "services" && p.command);
}

/**
 * The nodes making up one cycle, or null.
 *
 * Returns the path rather than a boolean — `generateCompose` already reports
 * *that* there is a cycle, and "Dependency graph has a cycle" sends you
 * looking at every edge on the canvas. Naming the three nodes involved is the
 * difference between a warning and a fix.
 */
export function findCycle(
  edges: Array<{ sourceId: string; targetId: string }>,
): string[] | null {
  const adj = new Map<string, string[]>();
  for (const e of edges) {
    adj.set(e.sourceId, [...(adj.get(e.sourceId) ?? []), e.targetId]);
  }

  const state = new Map<string, "visiting" | "done">();
  const stack: string[] = [];

  const visit = (id: string): string[] | null => {
    if (state.get(id) === "done") return null;
    if (state.get(id) === "visiting") {
      // The cycle is the tail of the current stack from this node onwards.
      return [...stack.slice(stack.indexOf(id)), id];
    }
    state.set(id, "visiting");
    stack.push(id);
    for (const next of adj.get(id) ?? []) {
      const found = visit(next);
      if (found) return found;
    }
    stack.pop();
    state.set(id, "done");
    return null;
  };

  for (const id of adj.keys()) {
    const found = visit(id);
    if (found) return found;
  }
  return null;
}
