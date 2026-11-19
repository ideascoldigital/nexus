import { prisma } from "@nexux/db";
import { NextRequest, NextResponse } from "next/server";

import { sandboxReachable } from "@/lib/agent-core";
import { isLocalTarget, navigateSession } from "@/lib/browser-cdp";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ projectId: string; sandboxId: string }> };

// POST — point the session at a URL, over CDP.
//
// VNC carries pixels and input and has no concept of a URL, so the address bar
// cannot be served over the same channel the screen arrives on.
export async function POST(req: NextRequest, { params }: Params) {
  const { projectId, sandboxId } = await params;
  const body = (await req.json().catch(() => ({}))) as { url?: unknown };
  const url = typeof body.url === "string" ? body.url : "";

  if (!isLocalTarget(url)) {
    // Not a validation nicety: a session that could be pointed anywhere turns
    // a browser holding this instance's localhost into a general-purpose
    // fetcher for whatever can reach this route.
    return NextResponse.json(
      {
        error:
          "A browser session can only be pointed at the sandbox's own services (localhost).",
      },
      { status: 400 },
    );
  }

  const sandbox = await prisma.sandbox.findFirst({
    where: { id: sandboxId, projectId },
  });
  if (!sandbox) {
    return NextResponse.json({ error: "Sandbox not found" }, { status: 404 });
  }
  if (!sandboxReachable(sandbox)) {
    return NextResponse.json(
      { error: "The sandbox is not running" },
      { status: 409 },
    );
  }

  const session = await prisma.browserSession.findUnique({
    where: { sandboxId },
  });
  if (!session || session.status !== "running") {
    return NextResponse.json(
      { error: "No browser session is running on this sandbox" },
      { status: 409 },
    );
  }

  const ok = await navigateSession(sandbox, session.cdpPort, url);
  if (!ok) {
    return NextResponse.json(
      { error: "The browser did not accept the address." },
      { status: 502 },
    );
  }
  return NextResponse.json({ success: true, url });
}
