import { NextRequest, NextResponse } from "next/server";

import { readBrowserSessionLog } from "@/lib/browser-session";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ projectId: string; sandboxId: string }> };

// GET — tail the session log from the instance, like the process log route.
export async function GET(_req: NextRequest, { params }: Params) {
  const { projectId, sandboxId } = await params;

  try {
    const log = await readBrowserSessionLog(projectId, sandboxId);
    return NextResponse.json({ log });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Could not read the log";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
