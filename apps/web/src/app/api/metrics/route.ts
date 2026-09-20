/**
 * This machine's vitals, and its sandboxes'.
 *
 * Exists because a host filled its disk and nothing in the product said so
 * until an unrelated command failed with an unrelated message. The status bar
 * polls this; `?sandboxes=1` adds the containers, and `?disk=1` adds their
 * filesystems, which cost an exec each and so are opt-in.
 */

import { NextRequest, NextResponse } from "next/server";

import { collectSandboxMetrics } from "@/lib/sandbox-metrics";
import { collectSystemMetrics } from "@/lib/system-metrics";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const wantSandboxes = req.nextUrl.searchParams.get("sandboxes") === "1";
  const wantDisk = req.nextUrl.searchParams.get("disk") === "1";

  // A docker that is not running must not take the host's own numbers with
  // it: the bar still has something true to show.
  const [system, sandboxes] = await Promise.all([
    collectSystemMetrics(),
    wantSandboxes
      ? collectSandboxMetrics({ withDisk: wantDisk }).catch(() => [])
      : Promise.resolve([]),
  ]);

  return NextResponse.json({ system, sandboxes });
}
