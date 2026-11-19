import { prisma } from "@nexux/db";
import { NextRequest, NextResponse } from "next/server";

import { sandboxDatabases } from "@/lib/seed/save";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ projectId: string; sandboxId: string }> };

/** The databases this sandbox runs, and each one's current project seed (spec 29). */
export async function GET(_req: NextRequest, { params }: Params) {
  const { projectId, sandboxId } = await params;
  const sandbox = await prisma.sandbox.findFirst({ where: { id: sandboxId, projectId } });
  if (!sandbox) return NextResponse.json({ error: "Sandbox not found" }, { status: 404 });
  return NextResponse.json({ databases: await sandboxDatabases(sandbox) });
}
