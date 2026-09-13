import { NextRequest, NextResponse } from "next/server";

import {
  getBrowserSession,
  startBrowserSession,
  stopBrowserSession,
} from "@/lib/browser-session";

export const dynamic = "force-dynamic";
// Xvfb plus a cold Chromium, then the forward — the same bound the process
// route already chose for starting an app and waiting on its port.
export const maxDuration = 300;

type Params = { params: Promise<{ projectId: string; sandboxId: string }> };

// GET — the current session, if there is one.
export async function GET(_req: NextRequest, { params }: Params) {
  const { projectId, sandboxId } = await params;

  try {
    const session = await getBrowserSession(projectId, sandboxId);
    return NextResponse.json({ session });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Could not read the session";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

// POST — start (or restart) the browser on the sandbox.
export async function POST(req: NextRequest, { params }: Params) {
  const { projectId, sandboxId } = await params;
  const body = (await req.json().catch(() => ({}))) as {
    width?: unknown;
    height?: unknown;
  };
  const dimension = (value: unknown) =>
    typeof value === "number" && Number.isInteger(value) ? value : undefined;

  try {
    const session = await startBrowserSession(projectId, sandboxId, {
      width: dimension(body.width),
      height: dimension(body.height),
    });
    if (session.status === "error") {
      // The row carries why, and the log route has the detail — a 502 with the
      // reason beats a 200 the UI has to re-inspect to notice the failure.
      return NextResponse.json(
        { error: session.error ?? "The browser session did not start", session },
        { status: 502 },
      );
    }
    return NextResponse.json({ session });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Could not start the session";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

// DELETE — stop the browser and drop the forward.
export async function DELETE(_req: NextRequest, { params }: Params) {
  const { projectId, sandboxId } = await params;

  try {
    await stopBrowserSession(projectId, sandboxId);
    return NextResponse.json({ success: true });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Could not stop the session";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
