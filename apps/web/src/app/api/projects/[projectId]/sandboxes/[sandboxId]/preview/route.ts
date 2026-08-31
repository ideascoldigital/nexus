import { NextRequest, NextResponse } from "next/server";
import { startSandboxPreview, stopSandboxPreview } from "@/lib/task-manager";

export const dynamic = "force-dynamic";
// Booting the app and waiting for its port can take a couple of minutes.
export const maxDuration = 300;

type Params = { params: Promise<{ projectId: string; sandboxId: string }> };

// POST — run the app on the instance and expose it on a Cloudflare quick
// tunnel. Replaces any preview already running there.
export async function POST(_req: NextRequest, { params }: Params) {
  const { projectId, sandboxId } = await params;

  try {
    const result = await startSandboxPreview(projectId, sandboxId);
    if (!result.previewUrl) {
      return NextResponse.json(
        {
          error:
            "The app did not start, or the tunnel could not open. Check the run command and port.",
          log: result.log,
        },
        { status: 502 },
      );
    }
    return NextResponse.json(result);
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Could not start the preview";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

// DELETE — stop the app and the tunnel.
export async function DELETE(_req: NextRequest, { params }: Params) {
  const { projectId, sandboxId } = await params;

  try {
    await stopSandboxPreview(projectId, sandboxId);
    return NextResponse.json({ success: true });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Could not stop the preview";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
