// docker-compose generation from a project stack graph. Pure function — no
// filesystem or docker access, so it's unit-testable.

import { stringify } from "yaml";

import { healthcheckFor } from "./healthcheck";

export interface StackPort {
  host: number;
  container: number;
}

export interface StackEnvVar {
  key: string;
  value: string;
}

export interface StackVolume {
  /** Absolute/relative host path (contains "/") or named volume otherwise. */
  host: string;
  container: string;
}

export interface StackNodeSpec {
  id: string;
  kind: "repo" | "service";
  name: string;
  runMode: "docker" | "local";
  /** Absolute path on disk (repo nodes). */
  localPath?: string | null;
  image?: string | null;
  dockerfile?: string | null;
  buildContext?: string | null;
  command?: string | null;
  ports?: StackPort[] | null;
  env?: StackEnvVar[] | null;
  volumes?: StackVolume[] | null;
}

export interface ComposeInput {
  projectName: string;
  nodes: StackNodeSpec[];
  edges: { sourceId: string; targetId: string }[];
}

export interface ComposeOutput {
  yaml: string;
  warnings: string[];
  /** nodeId -> compose service name, for status mapping. */
  serviceNames: Record<string, string>;
}

export function slugifyServiceName(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "service";
}

function detectCycle(
  edges: { sourceId: string; targetId: string }[]
): boolean {
  const adj = new Map<string, string[]>();
  for (const e of edges) {
    adj.set(e.sourceId, [...(adj.get(e.sourceId) ?? []), e.targetId]);
  }
  const visiting = new Set<string>();
  const done = new Set<string>();
  const visit = (id: string): boolean => {
    if (done.has(id)) return false;
    if (visiting.has(id)) return true;
    visiting.add(id);
    for (const next of adj.get(id) ?? []) {
      if (visit(next)) return true;
    }
    visiting.delete(id);
    done.add(id);
    return false;
  };
  return Array.from(adj.keys()).some(visit);
}

export function generateCompose(input: ComposeInput): ComposeOutput {
  const warnings: string[] = [];

  const dockerNodes = input.nodes
    .filter((n) => n.runMode === "docker")
    .sort((a, b) => a.name.localeCompare(b.name));
  const localNodes = input.nodes.filter((n) => n.runMode === "local");
  const localIds = new Set(localNodes.map((n) => n.id));

  // Assign deterministic, deduped service names
  const serviceNames: Record<string, string> = {};
  const used = new Set<string>();
  for (const node of dockerNodes) {
    let name = slugifyServiceName(node.name);
    let i = 2;
    while (used.has(name)) name = `${slugifyServiceName(node.name)}-${i++}`;
    used.add(name);
    serviceNames[node.id] = name;
  }

  if (detectCycle(input.edges)) {
    warnings.push("Dependency graph has a cycle — depends_on may misbehave.");
  }

  const namedVolumes = new Set<string>();
  const services: Record<string, Record<string, unknown>> = {};

  for (const node of dockerNodes) {
    const svcName = serviceNames[node.id];
    const svc: Record<string, unknown> = {};

    if (node.kind === "repo") {
      if (!node.localPath) {
        warnings.push(
          `"${node.name}" is a docker-mode repo without a local path — skipped.`
        );
        delete serviceNames[node.id];
        continue;
      }
      const context = node.buildContext
        ? `${node.localPath.replace(/\/+$/, "")}/${node.buildContext.replace(/^\.?\/+/, "")}`
        : node.localPath;
      svc.build = {
        context,
        dockerfile: node.dockerfile || "Dockerfile",
      };
    } else {
      if (!node.image) {
        warnings.push(`"${node.name}" is a service without an image — skipped.`);
        delete serviceNames[node.id];
        continue;
      }
      svc.image = node.image;
    }

    if (node.command) svc.command = node.command;

    // Readiness, for the images we recognize (spec 24 piece 2). Without this
    // the bootstrap's `--wait` waits for "running", which for a database is
    // true seconds before it accepts a connection — the race a repo's install
    // loses when it runs migrations.
    const health = healthcheckFor(node.image);
    if (health) svc.healthcheck = health;

    const ports = (node.ports ?? []).filter(
      (p) => p.host > 0 && p.container > 0
    );
    if (ports.length > 0) {
      svc.ports = ports.map((p) => `${p.host}:${p.container}`);
    }

    const env = (node.env ?? []).filter((e) => e.key);
    if (env.length > 0) {
      svc.environment = Object.fromEntries(env.map((e) => [e.key, e.value]));
    }

    const volumes = (node.volumes ?? []).filter((v) => v.host && v.container);
    if (volumes.length > 0) {
      svc.volumes = volumes.map((v) => `${v.host}:${v.container}`);
      for (const v of volumes) {
        if (!v.host.includes("/")) namedVolumes.add(v.host);
      }
    }

    const dependsOn: string[] = [];
    for (const edge of input.edges) {
      if (edge.sourceId !== node.id) continue;
      if (localIds.has(edge.targetId)) {
        const target = localNodes.find((n) => n.id === edge.targetId);
        warnings.push(
          `"${node.name}" depends on "${target?.name ?? edge.targetId}" which runs locally — not expressible in compose.`
        );
        continue;
      }
      const targetName = serviceNames[edge.targetId];
      if (targetName) dependsOn.push(targetName);
    }
    if (dependsOn.length > 0) {
      // Long form, so a dependency that has a healthcheck is waited *for*, not
      // merely started before. The short-form list ignores health entirely —
      // which would leave a generated healthcheck doing half its job: `--wait`
      // would honour it at the top level while a dependent service still
      // started against a database that was not accepting connections yet.
      //
      // `service_started` for the rest: an image we do not recognize has no
      // health to wait on, and demanding it would hang the `up` forever.
      svc.depends_on = Object.fromEntries(
        dependsOn.sort().map((name) => {
          const target = dockerNodes.find((n) => serviceNames[n.id] === name);
          return [
            name,
            {
              condition: healthcheckFor(target?.image)
                ? "service_healthy"
                : "service_started",
            },
          ];
        })
      );
    }

    services[svcName] = svc;
  }

  const doc: Record<string, unknown> = { name: input.projectName, services };
  if (namedVolumes.size > 0) {
    doc.volumes = Object.fromEntries(
      Array.from(namedVolumes)
        .sort()
        .map((v) => [v, null])
    );
  }

  const yaml =
    Object.keys(services).length > 0
      ? stringify(doc, { lineWidth: 0 })
      : "";

  return { yaml, warnings, serviceNames };
}
