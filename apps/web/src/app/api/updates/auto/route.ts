/**
 * What the background auto-updater has done (lib/auto-update.ts) — polled by
 * the "update installed, restart" notice. Native only: elsewhere there is no
 * auto-updater, and the 404 tells the notice to stay hidden.
 */

import { NextResponse } from "next/server";

import { autoUpdateState } from "@/lib/auto-update";

export const dynamic = "force-dynamic";

export async function GET() {
  if (process.env.NEXUX_NATIVE !== "1") {
    return NextResponse.json({ error: "native app only" }, { status: 404 });
  }
  return NextResponse.json(autoUpdateState());
}
