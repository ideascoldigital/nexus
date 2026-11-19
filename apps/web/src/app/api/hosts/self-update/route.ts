/**
 * The host updating *itself*, from its own Settings page.
 *
 * Refused anywhere else: on a laptop there is no control mount and no stack to
 * restart, and the button that reaches this route is only rendered on a host.
 */

import { NextResponse } from "next/server";

import {
  isHostInstall,
  readSelfUpdateLog,
  requestSelfUpdate,
  selfImage,
} from "@/lib/host-update";

export const dynamic = "force-dynamic";

export async function GET() {
  if (!isHostInstall()) {
    return NextResponse.json({ log: null, isHost: false });
  }
  return NextResponse.json({ log: await readSelfUpdateLog(), isHost: true, ...selfImage() });
}

export async function POST(req: Request) {
  if (!isHostInstall()) {
    return NextResponse.json(
      {
        error:
          "This install is not a Nexus host. Update a host from its row in Settings → Backup & migration.",
      },
      { status: 400 },
    );
  }
  // Optional `{ channel }`: switch this host to edge or latest as it updates.
  const body = (await req.json().catch(() => ({}))) as { channel?: unknown };
  const channel = body.channel === "edge" || body.channel === "latest" ? body.channel : undefined;
  if (body.channel !== undefined && !channel) {
    return NextResponse.json({ error: "channel must be edge or latest" }, { status: 400 });
  }
  return NextResponse.json(await requestSelfUpdate(channel));
}
