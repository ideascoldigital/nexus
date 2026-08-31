/**
 * SSH access to a Nexus host. Spec: `specs/19-nexus-host-provisioning.md`.
 *
 * POST registers the host in Nexus's managed SSH config and returns how to
 * reach it: the alias, the `ssh` command to paste, and the `ssh://` target the
 * in-app terminal connects with. It is a POST rather than a GET because it
 * writes ~/.ssh/config — the same trade the sandbox VS Code route makes.
 */

import { prisma } from "@nexux/db";
import { NextRequest, NextResponse } from "next/server";

import { ensureHostSshAccess } from "@/lib/host-ssh";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ hostId: string }> };

export async function POST(_req: NextRequest, { params }: Params) {
  const { hostId } = await params;
  const host = await prisma.nexusHost.findUnique({ where: { id: hostId } });
  if (!host) {
    return NextResponse.json({ error: "Host not found" }, { status: 404 });
  }

  try {
    const target = ensureHostSshAccess(host);
    if (!target) {
      return NextResponse.json(
        { error: "The host has no address yet — it is still being created." },
        { status: 409 },
      );
    }
    return NextResponse.json(target);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // The stack matters here: these failures are keypair / ssh-config file
    // plumbing, and the message alone ("EACCES") never says which path.
    const log = err instanceof Error ? err.stack : undefined;
    return NextResponse.json({ error: message, log }, { status: 500 });
  }
}
