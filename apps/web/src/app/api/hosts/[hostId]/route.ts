/**
 * One Nexus host: full row (log included) and destroy.
 * Spec: `specs/19-nexus-host-provisioning.md`.
 */

import { prisma } from "@nexux/db";
import { NextRequest, NextResponse } from "next/server";

import { destroyHost } from "@/lib/host-manager";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ hostId: string }> };

export async function GET(_req: NextRequest, { params }: Params) {
  const { hostId } = await params;
  const host = await prisma.nexusHost.findUnique({ where: { id: hostId } });
  if (!host) {
    return NextResponse.json({ error: "Host not found" }, { status: 404 });
  }
  return NextResponse.json(host);
}

export async function DELETE(_req: NextRequest, { params }: Params) {
  const { hostId } = await params;
  try {
    // Deliberately works on a half-provisioned or errored host: those still
    // have a billed VM behind them, and refusing would strand it.
    const host = await destroyHost(hostId);
    return NextResponse.json(host);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Could not destroy the host" },
      { status: 400 },
    );
  }
}
