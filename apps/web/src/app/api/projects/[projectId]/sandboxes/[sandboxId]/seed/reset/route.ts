import { prisma } from "@nexux/db";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { resetSandboxData, seedsForSandbox } from "@/lib/seed/reset";

export const dynamic = "force-dynamic";
export const maxDuration = 3600;

type Params = { params: Promise<{ projectId: string; sandboxId: string }> };

const bodySchema = z.object({
  /** One service; omitted resets every seeded service. */
  service: z.string().min(1).optional(),
  /** Re-run the repos' install step (migrations) afterwards. Default true. */
  runSetup: z.boolean().optional(),
});

async function ownedSandbox(projectId: string, sandboxId: string) {
  return prisma.sandbox.findFirst({ where: { id: sandboxId, projectId } });
}

/** Which services this sandbox can be reset to — for the menu, before asking. */
export async function GET(_req: NextRequest, { params }: Params) {
  const { projectId, sandboxId } = await params;
  const sandbox = await ownedSandbox(projectId, sandboxId);
  if (!sandbox) return NextResponse.json({ error: "Sandbox not found" }, { status: 404 });
  const seeds = await seedsForSandbox(sandbox);
  return NextResponse.json({
    seeds: seeds.map((s) => ({ service: s.spec.service, fileName: s.spec.fileName, sizeBytes: s.spec.sizeBytes })),
  });
}

/**
 * Spec 29 phase 3: empty each seeded database, restore its seed, then re-run
 * the repos' install step. Waits for the whole thing; a restore that failed
 * comes back 200 with `ok: false` and the service's message.
 */
export async function POST(req: NextRequest, { params }: Params) {
  const { projectId, sandboxId } = await params;
  const sandbox = await ownedSandbox(projectId, sandboxId);
  if (!sandbox) return NextResponse.json({ error: "Sandbox not found" }, { status: 404 });
  const parsed = bodySchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  try {
    return NextResponse.json(await resetSandboxData(sandboxId, parsed.data));
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Reset failed" }, { status: 409 });
  }
}
