/**
 * Updating a Nexus host to a newer image. Spec: `specs/19-nexus-host-provisioning.md`.
 *
 * Two routes to the same operation — `docker compose pull && up -d` in
 * `/opt/nexus-host` — because there are two places the user might be standing:
 *
 * 1. **From the local install**, over the SSH access provisioning already set
 *    up. The laptop holds the keypair, so it can simply run the command.
 * 2. **From the host's own dashboard**, where it cannot. The container has no
 *    docker socket by design (mounting it is root-equivalent on the host,
 *    D-34) and no key to SSH to its own machine, so it writes a request file
 *    into a bind-mounted directory and a root-side systemd path unit does the
 *    work. That indirection is the point: the app can ask to be updated and
 *    cannot ask for anything else.
 *
 * Both keep the named volumes. `down -v` would take the database, the saved
 * credentials and the search indexes with it; `up -d` recreates only the
 * containers whose image changed.
 */

import fs from "fs/promises";

import { prisma } from "@nexux/db";
import {
  execRemote,
  HOST_DIR,
  HOST_UPDATE_LOG,
  sandboxPrivateKeyPath,
} from "@nexux/sandbox";
import { getConfig } from "@nexux/config";

import { hostSshAddress, hostSshUser } from "@/lib/host-ssh";

/** Where the control directory is mounted inside the host's own container. */
const CONTROL_MOUNT = "/host-control";

export type HostUpdateResult = {
  /** True when the update ran to completion, or was accepted by the host. */
  ok: boolean;
  message: string;
  /** Whatever the pull printed, for the UI to show without an SSH session. */
  log?: string;
  /**
   * Whether the pull actually changed the running image. Undefined on the
   * self-update path, which cannot know — it only files the request.
   */
  updated?: boolean;
};

/** Whether this install is the host itself, rather than someone's laptop. */
export function isHostInstall(): boolean {
  return process.env.NEXUX_ROLE === "host";
}

/**
 * Ask this machine's own updater to run.
 *
 * Nothing is awaited beyond the request being written: `up -d` recreates the
 * container serving this very request, so the process handling it is killed
 * partway through by design. The UI has to survive the app going away and
 * coming back, which is why the message says so rather than pretending the
 * operation completed.
 */
export async function requestSelfUpdate(): Promise<HostUpdateResult> {
  const request = `${CONTROL_MOUNT}/update-requested`;
  try {
    await fs.writeFile(request, `${new Date().toISOString()}\n`);
  } catch (err) {
    // The mount is missing on a host provisioned before self-update existed.
    // Say which command brings it back rather than failing blankly.
    return {
      ok: false,
      message:
        (err as { code?: string }).code === "ENOENT"
          ? `This host has no update helper — it was created before self-update existed. Update it from your local install, or run \`${HOST_DIR}/update.sh\` on the machine.`
          : `Could not write the update request: ${
              err instanceof Error ? err.message : String(err)
            }`,
    };
  }

  return {
    ok: true,
    message:
      "Update requested. The app restarts as part of it, so this page will drop out for a minute — reload once it comes back.",
  };
}

/** The last thing the on-host updater printed, if it has ever run. */
export async function readSelfUpdateLog(): Promise<string | null> {
  try {
    return await fs.readFile(`${CONTROL_MOUNT}/update.log`, "utf8");
  } catch {
    return null;
  }
}

/**
 * Update a host from this install, over SSH.
 *
 * Runs the pull directly rather than poking the systemd unit: this side has a
 * shell, so it can report what actually happened instead of "requested". The
 * `up -d` still races the connection — recreating the container does not touch
 * sshd, so unlike the self-update path the command survives its own effect.
 */
export async function updateHost(hostId: string): Promise<HostUpdateResult> {
  const host = await prisma.nexusHost.findUnique({ where: { id: hostId } });
  if (!host) throw new Error("Host not found");
  if (host.status !== "running") {
    throw new Error(
      `This host is ${host.status}, not running — there is nothing to update yet.`,
    );
  }
  if (host.provider === "docker-endpoint") {
    // Spec 27 phase 3 — until then, say how rather than try SSH to a box
    // that has none.
    throw new Error(
      `Updating a host on a Docker endpoint isn't available yet. On the endpoint: docker compose -p ${host.instanceId ?? "nexus-host-<name>"} pull && up -d.`,
    );
  }

  const address = hostSshAddress(host);
  if (!address) {
    throw new Error(
      "This host has no address to connect to. It may still be provisioning.",
    );
  }

  const privateKeyPath = sandboxPrivateKeyPath(getConfig().dataDir);
  const result = await execRemote(
    // The image id of the running container, echoed before and after: "did
    // this update change anything" is otherwise unanswerable — a pull that
    // found nothing and a pull that replaced the stack print near-identical
    // output, and the UI needs to say "already up to date" for one of them.
    `cd ${HOST_DIR} && echo "nexus-image-before=$(docker compose images --quiet nexux | head -1)" && docker compose pull && docker compose up -d && echo "nexus-image-after=$(docker compose images --quiet nexux | head -1)"`,
    {
      host: address.host,
      user: hostSshUser(host),
      privateKeyPath,
      timeoutMs: 10 * 60 * 1000,
    },
  ).catch((err: unknown) => ({
    code: 1,
    stdout: "",
    stderr: err instanceof Error ? err.message : String(err),
  }));

  const log = `${result.stdout}${result.stderr}`.trim().slice(-8000);
  if (result.code !== 0) {
    return {
      ok: false,
      message:
        "The update failed on the host. The stack is still running the old image.",
      log,
    };
  }

  const before = result.stdout.match(/^nexus-image-before=(\S+)$/m)?.[1] ?? null;
  const after = result.stdout.match(/^nexus-image-after=(\S+)$/m)?.[1] ?? null;
  // Only claim "nothing changed" when both ids were actually captured — an
  // empty echo (compose renamed a flag, container briefly gone) must degrade
  // to the honest generic message, not to a false "already up to date".
  const updated = before && after ? before !== after : undefined;
  return {
    ok: true,
    message:
      updated === false
        ? "Already up to date — the pull found no newer image."
        : updated
          ? "Updated — the host is now running the new image."
          : "Updated and restarted.",
    log,
    updated,
  };
}

/** The on-host updater's log, read over SSH — the remote half of the pair. */
export async function readHostUpdateLog(hostId: string): Promise<string | null> {
  const host = await prisma.nexusHost.findUnique({ where: { id: hostId } });
  if (!host || host.status !== "running") return null;
  const address = hostSshAddress(host);
  if (!address) return null;

  const result = await execRemote(`cat ${HOST_UPDATE_LOG} 2>/dev/null || true`, {
    host: address.host,
    user: hostSshUser(host),
    privateKeyPath: sandboxPrivateKeyPath(getConfig().dataDir),
    timeoutMs: 20_000,
  }).catch(() => null);
  return result?.stdout?.trim() || null;
}
