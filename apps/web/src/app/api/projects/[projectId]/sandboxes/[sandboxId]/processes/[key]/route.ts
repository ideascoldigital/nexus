import { NextRequest, NextResponse } from "next/server";
import {
  readSandboxProcessLog,
  startSandboxProcess,
  stopSandboxProcess,
} from "@/lib/sandbox-process-manager";

export const dynamic = "force-dynamic";
// Booting a process and waiting for its port can take a couple of minutes.
export const maxDuration = 300;

type Params = {
  params: Promise<{ projectId: string; sandboxId: string; key: string }>;
};

// A key travels as one path segment, so "<nodeId>#<i>" arrives encoded.
const decodeKey = (raw: string) => decodeURIComponent(raw);

// GET — tail this process's log.
export async function GET(_req: NextRequest, { params }: Params) {
  const { projectId, sandboxId, key } = await params;

  try {
    const log = await readSandboxProcessLog(
      projectId,
      sandboxId,
      decodeKey(key),
    );
    return NextResponse.json({ log });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Could not read the log";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

// POST — start (or restart) this process.
export async function POST(req: NextRequest, { params }: Params) {
  const { projectId, sandboxId, key } = await params;
  const body = (await req.json().catch(() => ({}))) as { tunnel?: boolean };

  try {
    const result = await startSandboxProcess(
      projectId,
      sandboxId,
      decodeKey(key),
      { tunnel: body.tunnel },
    );
    return NextResponse.json(result);
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Could not start the process";
    // startSandboxProcess attaches the remote log tail — without it the user
    // gets "it failed" and nothing to act on.
    const log = (err as Error & { log?: string })?.log;
    return NextResponse.json({ error: message, log }, { status: 502 });
  }
}

// DELETE — stop this process (and its tunnel).
export async function DELETE(_req: NextRequest, { params }: Params) {
  const { projectId, sandboxId, key } = await params;

  try {
    await stopSandboxProcess(projectId, sandboxId, decodeKey(key));
    return NextResponse.json({ success: true });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Could not stop the process";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
