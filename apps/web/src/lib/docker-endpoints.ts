/**
 * Remote Docker endpoints — server side. Spec: `specs/26-remote-docker-endpoints.md`.
 */

import { prisma } from "@nexux/db";
import { probeDockerEndpoint, type ProbeResult } from "@nexux/sandbox";

/** Sandbox statuses that still hold a container on the endpoint. */
const GONE = ["destroyed"];

/**
 * `NEXUX_TEST_DOCKER_PROBE` holds a JSON ProbeResult for the route tests: CI
 * has no remote daemon to reach. An env var rather than a mutable export, so
 * production has no way to reach it — same discipline as NEXUX_TEST_TERRAFORM.
 */
export async function probe(host: string): Promise<ProbeResult> {
  const override = process.env.NEXUX_TEST_DOCKER_PROBE;
  if (override) return JSON.parse(override) as ProbeResult;
  return probeDockerEndpoint(host);
}

/** Probe results as row columns. A failure keeps the last good facts. */
export function probeColumns(res: ProbeResult) {
  const lastCheckedAt = new Date();
  if (!res.ok) return { lastCheckedAt, lastError: res.error };
  return {
    lastCheckedAt,
    lastError: null,
    serverVersion: res.serverVersion,
    arch: res.arch,
    memTotalMb: res.memTotalMb,
  };
}

/** Sandboxes that would lose their daemon if the endpoint went away. */
export function liveSandboxCount(endpointId: string): Promise<number> {
  return prisma.sandbox.count({
    where: { dockerEndpointId: endpointId, status: { notIn: GONE } },
  });
}

export async function listEndpoints() {
  const rows = await prisma.dockerEndpoint.findMany({ orderBy: { createdAt: "asc" } });
  return Promise.all(
    rows.map(async (r) => ({ ...r, sandboxCount: await liveSandboxCount(r.id) })),
  );
}
