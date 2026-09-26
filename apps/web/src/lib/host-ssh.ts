/**
 * SSH access to a Nexus host. Spec: `specs/19-nexus-host-provisioning.md`.
 *
 * Provisioning already registers Nexus's keypair on every host — the bootstrap
 * monitor SSHes in to read the completion marker. This module turns that
 * existing access into something the user can reach: a Host entry in the
 * managed SSH config, a copyable `ssh` command, and the in-app terminal /
 * VS Code Remote-SSH targets, the same way sandboxes already work.
 */

import { getConfig } from "@nexux/config";
import {
  ensureSandboxKeypair,
  ensureUserSshInclude,
  initialSshUser,
  sandboxPrivateKeyPath,
  upsertSandboxSshHost,
} from "@nexux/sandbox";

/** The host fields SSH access needs — a subset of the Prisma row. */
export type HostSshSource = {
  name: string;
  status: string;
  provider: string;
  publicIp: string | null;
  tailscaleIp: string | null;
  tailscaleName: string | null;
};

export type HostSshTarget = {
  /** Host alias in the managed SSH config — `ssh <alias>` resolves it. */
  alias: string;
  /** Address ssh connects to. */
  host: string;
  user: string;
  privateKeyPath: string;
  /** A ready-to-paste command that works without the managed config. */
  command: string;
  /** `ssh://user@host/path` — what the terminal server expects as its cwd. */
  terminalTarget: string;
  /** True when the connection goes over the tailnet rather than the public IP. */
  overTailnet: boolean;
};

/**
 * Which login the host accepts.
 *
 * The bootstrap rewrites /root/.ssh/authorized_keys with Nexus's key on both
 * providers, so a host that finished bootstrapping is always reachable as
 * root. Before that, only the provider's initial account works — AWS images
 * refuse root with "Please login as the user \"ubuntu\"" until cloud-init has
 * replaced that entry.
 */
export function hostSshUser(host: {
  status: string;
  provider: string;
}): string {
  if (host.status === "running") return "root";
  return initialSshUser(host.provider === "aws" ? "aws" : "civo");
}

/**
 * The address to connect to.
 *
 * The tailnet address is preferred whenever it is known: a host serves the
 * unauthenticated app on it by design (D-34), so the user is on that tailnet
 * already, and it keeps administration off the public interface. The public IP
 * is the fallback — it is what the bootstrap monitor uses, and it is the only
 * address available before Tailscale comes up.
 */
export function hostSshAddress(
  host: Pick<HostSshSource, "publicIp" | "tailscaleIp" | "tailscaleName">,
): { host: string; overTailnet: boolean } | null {
  const tailnet = host.tailscaleIp?.trim() || host.tailscaleName?.trim();
  if (tailnet) return { host: tailnet, overTailnet: true };
  const publicIp = host.publicIp?.trim();
  if (publicIp) return { host: publicIp, overTailnet: false };
  return null;
}

/**
 * Register the host in Nexus's managed SSH config and describe how to reach it.
 *
 * Writes the same marker-delimited block sandboxes use (`<dataDir>/ssh/config`,
 * Included from ~/.ssh/config), so `ssh <name>` and VS Code Remote-SSH resolve
 * the host with no manual setup. Idempotent — re-running after the tailnet
 * address appears replaces the block with the better address.
 *
 * Returns null when the host has no address yet.
 */
export function ensureHostSshAccess(host: HostSshSource): HostSshTarget | null {
  // A host on a Docker endpoint has no sshd of its own — its stack is
  // containers on someone else's machine (spec 27). Its terminal goes through
  // the endpoint instead; there is no SSH target to hand out.
  if (host.provider === "docker-endpoint") {
    throw new Error(
      "A host on a Docker endpoint has no SSH of its own — open its terminal from the host's row instead.",
    );
  }
  const address = hostSshAddress(host);
  if (!address) return null;

  const dataDir = getConfig().dataDir;
  // Normally created at provision time; guaranteed here so the IdentityFile
  // the Host entry points at is never dangling.
  ensureSandboxKeypair(dataDir);
  const user = hostSshUser(host);
  const alias = upsertSandboxSshHost({
    dataDir,
    name: host.name,
    host: address.host,
    user,
  });
  ensureUserSshInclude(dataDir);

  const privateKeyPath = sandboxPrivateKeyPath(dataDir);
  return {
    alias,
    host: address.host,
    user,
    privateKeyPath,
    // Spelled out rather than `ssh <alias>`: the command stays correct when it
    // is pasted on another machine, or before ~/.ssh/config is re-read.
    command: `ssh -i ${privateKeyPath} -o IdentitiesOnly=yes ${user}@${address.host}`,
    terminalTarget: `ssh://${user}@${address.host}/`,
    overTailnet: address.overTailnet,
  };
}
