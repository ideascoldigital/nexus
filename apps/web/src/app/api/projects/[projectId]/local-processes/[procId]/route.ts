import { NextRequest, NextResponse } from "next/server";

import { localRequestRejection } from "@/lib/local-request";
import { getLocalProcess, stopLocalProcess } from "@/lib/local-processes";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ projectId: string; procId: string }> };

/** Stop one of the project's apps running on this Mac (its whole process group). */
export async function DELETE(req: NextRequest, { params }: Params) {
  // The page sends it as JSON, so the same local-only guard as starting applies.
  const rejected = localRequestRejection(req);
  if (rejected) return NextResponse.json({ error: rejected }, { status: 403 });
  const { projectId, procId } = await params;
  const proc = getLocalProcess(procId);
  if (!proc || proc.projectId !== projectId) return NextResponse.json({ error: "Not found" }, { status: 404 });
  stopLocalProcess(procId);
  return NextResponse.json({ ok: true });
}
