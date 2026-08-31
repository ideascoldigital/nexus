/**
 * Update one host from this install, over SSH. The host's *own* dashboard uses
 * `/api/hosts/self-update` instead — it has no key to reach its own machine.
 */

import { NextRequest, NextResponse } from "next/server";

import { readHostUpdateLog, updateHost } from "@/lib/host-update";

type Params = { params: Promise<{ hostId: string }> };

export const dynamic = "force-dynamic";
export const maxDuration = 600;

export async function GET(_req: NextRequest, { params }: Params) {
  const { hostId } = await params;
  return NextResponse.json({ log: await readHostUpdateLog(hostId) });
}

export async function POST(_req: NextRequest, { params }: Params) {
  const { hostId } = await params;
  try {
    // A pull that failed comes back 200 with `ok: false`: the host is fine and
    // still serving the old image, which is an outcome, not a bad request.
    return NextResponse.json(await updateHost(hostId));
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Could not update the host" },
      { status: 400 },
    );
  }
}
