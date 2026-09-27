import { prisma } from "@nexux/db";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { saveSandboxDataAsSeed } from "@/lib/seed/save";
import { SeedError } from "@/lib/seed/store";

export const dynamic = "force-dynamic";
export const maxDuration = 3600;

type Params = { params: Promise<{ projectId: string; sandboxId: string }> };

const bodySchema = z.object({ service: z.string().min(1) });

/**
 * Save as seed (spec 29 phase 4): dump one database from this sandbox and
 * make it the project's seed for that service, replacing the current one.
 */
export async function POST(req: NextRequest, { params }: Params) {
  const { projectId, sandboxId } = await params;
  const sandbox = await prisma.sandbox.findFirst({ where: { id: sandboxId, projectId }, select: { id: true } });
  if (!sandbox) return NextResponse.json({ error: "Sandbox not found" }, { status: 404 });
  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  try {
    return NextResponse.json(await saveSandboxDataAsSeed(sandboxId, parsed.data.service), { status: 201 });
  } catch (err) {
    if (err instanceof SeedError) return NextResponse.json({ error: err.message }, { status: err.status });
    throw err;
  }
}
