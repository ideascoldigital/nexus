/**
 * One remote Docker endpoint — rename and remove. Spec 26.
 *
 * The host is deliberately not editable: sandboxes created on it live on that
 * daemon, and pointing the row somewhere else would orphan them silently.
 * Removing and re-adding makes the move explicit.
 */

import { prisma } from "@nexux/db";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { liveSandboxCount } from "@/lib/docker-endpoints";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ endpointId: string }> };

const patchSchema = z.object({
  name: z.string().trim().min(1, "A name is required").max(60),
});

export async function PATCH(req: NextRequest, { params }: Params) {
  const { endpointId } = await params;
  const parsed = patchSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  const row = await prisma.dockerEndpoint.findUnique({ where: { id: endpointId } });
  if (!row) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const updated = await prisma.dockerEndpoint.update({
    where: { id: endpointId },
    data: { name: parsed.data.name },
  });
  return NextResponse.json({
    ...updated,
    sandboxCount: await liveSandboxCount(endpointId),
  });
}

export async function DELETE(_req: NextRequest, { params }: Params) {
  const { endpointId } = await params;
  const row = await prisma.dockerEndpoint.findUnique({ where: { id: endpointId } });
  if (!row) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // Same rule as a credential in use: removing it would strand containers
  // Nexux can no longer reach to stop or destroy.
  const live = await liveSandboxCount(endpointId);
  if (live > 0) {
    return NextResponse.json(
      {
        error: `${live} sandbox${live === 1 ? "" : "es"} still run${live === 1 ? "s" : ""} on "${row.name}" — destroy ${live === 1 ? "it" : "them"} first.`,
      },
      { status: 409 },
    );
  }
  // Destroyed sandboxes keep their rows for history; the FK sets them to null.
  await prisma.dockerEndpoint.delete({ where: { id: endpointId } });
  return NextResponse.json({ ok: true });
}
