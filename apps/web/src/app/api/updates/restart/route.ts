/**
 * Quit and reopen the native app so an installed update takes effect (see
 * lib/relaunch.ts). Native only.
 *
 * Guarded by localRequestRejection (no auth here, D-34). Only when the Tauri
 * shell started this sidecar (NEXUX_SHELL=native): the relaunch script kills
 * this process's *parent*, which is a terminal shell if start.js was run by
 * hand.
 */

import { NextResponse } from "next/server";

import { canRelaunch } from "@/lib/auto-update";
import { localRequestRejection } from "@/lib/local-request";
import { relaunch } from "@/lib/relaunch";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  if (process.env.NEXUX_NATIVE !== "1") {
    return NextResponse.json({ error: "native app only" }, { status: 404 });
  }
  const refused = localRequestRejection(req);
  if (refused) return NextResponse.json({ error: refused }, { status: 403 });
  if (process.env.NEXUX_SHELL !== "native") {
    return NextResponse.json(
      { error: "not started by the Nexus app — relaunch it by hand" },
      { status: 409 },
    );
  }
  if (!canRelaunch(process.platform)) {
    return NextResponse.json(
      { error: `restart is not supported on ${process.platform} — relaunch Nexus by hand` },
      { status: 409 },
    );
  }
  try {
    relaunch();
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 409 },
    );
  }
  return NextResponse.json({ ok: true });
}
