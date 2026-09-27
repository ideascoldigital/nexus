/**
 * Update one host from this install, over SSH. The host's *own* dashboard uses
 * `/api/hosts/self-update` instead — it has no key to reach its own machine.
 */

import { NextRequest, NextResponse } from "next/server";

import { prisma } from "@nexux/db";

import { withChannel, type HostChannel } from "@/lib/host-channel";
import { readHostUpdateLog, updateHost } from "@/lib/host-update";

type Params = { params: Promise<{ hostId: string }> };

export const dynamic = "force-dynamic";
export const maxDuration = 600;

export async function GET(_req: NextRequest, { params }: Params) {
  const { hostId } = await params;
  return NextResponse.json({ log: await readHostUpdateLog(hostId) });
}

export async function POST(req: NextRequest, { params }: Params) {
  const { hostId } = await params;
  // Optional `{ channel }`: move the host to edge or latest (stable) as part
  // of this update — see host-channel.ts.
  const body = (await req.json().catch(() => ({}))) as { channel?: unknown };
  const channel =
    body.channel === "edge" || body.channel === "latest" ? (body.channel as HostChannel) : null;
  if (body.channel !== undefined && !channel) {
    return NextResponse.json({ error: "channel must be edge or latest" }, { status: 400 });
  }
  try {
    const host = channel
      ? await prisma.nexusHost.findUnique({ where: { id: hostId }, select: { imageRef: true } })
      : null;
    // A pull that failed comes back 200 with `ok: false`: the host is fine and
    // still serving the old image, which is an outcome, not a bad request.
    return NextResponse.json(
      await updateHost(hostId, host && channel ? { imageRef: withChannel(host.imageRef, channel) } : {}),
    );
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Could not update the host" },
      { status: 400 },
    );
  }
}
