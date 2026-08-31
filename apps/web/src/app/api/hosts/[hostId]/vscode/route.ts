/**
 * Open VS Code on a Nexus host over Remote-SSH.
 * Spec: `specs/19-nexus-host-provisioning.md`.
 *
 * Opens `/opt/nexus-host` — the host's own directory (docker-compose.yml, the
 * bootstrap marker and its logs). A host runs the published image rather than
 * repo checkouts, so there is no workspace file to generate the way sandboxes
 * do; the folder is fixed.
 */

import { prisma } from "@nexux/db";
import { NextRequest, NextResponse } from "next/server";
import { HOST_DIR, vsCodeRemoteUri } from "@nexux/sandbox";

import { ensureHostSshAccess } from "@/lib/host-ssh";
import { launchVsCode } from "@/lib/vscode-launch";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ hostId: string }> };

export async function POST(_req: NextRequest, { params }: Params) {
  const { hostId } = await params;
  const host = await prisma.nexusHost.findUnique({ where: { id: hostId } });
  if (!host) {
    return NextResponse.json({ error: "Host not found" }, { status: 404 });
  }
  if (host.status !== "running") {
    return NextResponse.json(
      { error: "The host is not running yet" },
      { status: 409 },
    );
  }

  try {
    const target = ensureHostSshAccess(host);
    if (!target) {
      return NextResponse.json(
        { error: "The host has no address yet — it is still being created." },
        { status: 409 },
      );
    }
    const uri = vsCodeRemoteUri(target.alias, HOST_DIR);
    const launched = await launchVsCode(uri);
    return NextResponse.json({ uri, host: target.alias, launched });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const log = err instanceof Error ? err.stack : undefined;
    return NextResponse.json({ error: message, log }, { status: 500 });
  }
}
