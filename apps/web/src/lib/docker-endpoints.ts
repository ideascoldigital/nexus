/**
 * Remote Docker endpoints — server side. Spec: `specs/26-remote-docker-endpoints.md`.
 */

import os from "os";

import { getConfig } from "@nexux/config";
import { prisma } from "@nexux/db";
import {
  dockerHostKind,
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

/**
 * Bot computers awake on this endpoint (spec 31, D-85). Counted by the
 * session's own `dockerHost`, not by the bot's current choice: a bot pointed
 * somewhere else after its computer started still has that computer here.
 */
export async function liveBotCount(endpointId: string): Promise<number> {
  const ep = await prisma.dockerEndpoint.findUnique({
    where: { id: endpointId },
    select: { host: true },
  });
  if (!ep) return 0;
  return prisma.botSession.count({
    where: { dockerHost: ep.host, status: { in: ["starting", "ready"] } },
  });
}

/** What the list shows per endpoint: what still runs there. */
export async function usage(endpointId: string) {
  const [sandboxCount, hostCount, botCount] = await Promise.all([
    liveSandboxCount(endpointId),
    liveHostCount(endpointId),
    liveBotCount(endpointId),
  ]);
  return { sandboxCount, hostCount, botCount };
}

export async function listEndpoints() {
  const rows = await prisma.dockerEndpoint.findMany({ orderBy: { createdAt: "asc" } });
  // `kind` is derived here rather than in the component: @nexux/sandbox
  // reaches for child_process, which has no business in a browser bundle.
  return Promise.all(
    rows.map(async (r) => ({
      ...r,
      kind: dockerHostKind(r.host),
      ...(await usage(r.id)),
    })),
  );
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
  // A unix socket is reached directly; there is no ssh to configure for it.
  if (dockerHostKind(dockerHost) !== "remote") return;
  const dataDir = getConfig().dataDir;
  hostEndpointKey();
  upsertEndpointSshHost(dataDir, dockerHost);
  ensureUserSshInclude(dataDir);
}

export function forgetEndpointSsh(dockerHost: string): void {
  if (!isHostInstall()) return;
  if (dockerHostKind(dockerHost) !== "remote") return;
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

/**
 * A bot may only be pointed at an endpoint that exists. Prisma's foreign key
 * would refuse it too, but as a 500 — this says what is wrong.
 */
export async function missingEndpoint(id: string | null | undefined): Promise<boolean> {
  if (!id) return false;
  return (await prisma.dockerEndpoint.count({ where: { id } })) === 0;
}
