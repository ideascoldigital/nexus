/**
 * Remote Docker endpoints — server side. Spec: `specs/26-remote-docker-endpoints.md`.
 */

import os from "os";

import { getConfig } from "@nexux/config";
import { prisma } from "@nexux/db";
import {
  ensureEndpointKeypair,
  ensureUserSshInclude,
  probeDockerEndpoint,
  removeEndpointSshHost,
  upsertEndpointSshHost,
  type ProbeResult,
} from "@nexux/sandbox";

import { isHostInstall } from "@/lib/host-update";

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

/** Nexus hosts whose stack runs on this endpoint (spec 27). */
export function liveHostCount(endpointId: string): Promise<number> {
  return prisma.nexusHost.count({
    where: { dockerEndpointId: endpointId, status: { notIn: GONE } },
  });
}

/** What the list shows per endpoint: what still runs there. */
export async function usage(endpointId: string) {
  const [sandboxCount, hostCount] = await Promise.all([
    liveSandboxCount(endpointId),
    liveHostCount(endpointId),
  ]);
  return { sandboxCount, hostCount };
}

export async function listEndpoints() {
  const rows = await prisma.dockerEndpoint.findMany({ orderBy: { createdAt: "asc" } });
  return Promise.all(rows.map(async (r) => ({ ...r, ...(await usage(r.id)) })));
}

// --- a Nexus host reaching endpoints over SSH (spec 27 phase 6) ----------------
//
// On a laptop `docker -H ssh://…` uses the user's own ~/.ssh — nothing here
// touches it. A host is a container with no key and no ssh config of its own,
// so it keeps an endpoint key in its data volume and one managed block per
// endpoint; its home is rebuilt on every update, hence the startup pass.

/** The host's endpoint key, made on first use. Null on a laptop. */
export function hostEndpointKey(): { publicKey: string } | null {
  if (!isHostInstall()) return null;
  const { publicKey } = ensureEndpointKeypair(getConfig().dataDir, `nexus-host-${os.hostname()}`);
  return { publicKey };
}

/** Make `docker -H <host>` from this host use its endpoint key. No-op on a laptop. */
export function prepareEndpointSsh(dockerHost: string): void {
  if (!isHostInstall()) return;
  const dataDir = getConfig().dataDir;
  hostEndpointKey();
  upsertEndpointSshHost(dataDir, dockerHost);
  ensureUserSshInclude(dataDir);
}

export function forgetEndpointSsh(dockerHost: string): void {
  if (!isHostInstall()) return;
  removeEndpointSshHost(getConfig().dataDir, dockerHost);
}

/** Startup on a host: the Include line and every endpoint's block, again. */
export async function restoreEndpointSsh(): Promise<number> {
  if (!isHostInstall()) return 0;
  const rows = await prisma.dockerEndpoint.findMany({ select: { host: true } });
  for (const r of rows) prepareEndpointSsh(r.host);
  ensureUserSshInclude(getConfig().dataDir);
  return rows.length;
}
