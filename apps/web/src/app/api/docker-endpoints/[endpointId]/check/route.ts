/**
 * Re-probe a remote Docker endpoint and record what it said. Spec 26.
 *
 * A failed check is saved, not thrown: the row stays, and the list shows the
 * error next to the last facts that were true.
 */

import { prisma } from "@nexux/db";
import { NextRequest, NextResponse } from "next/server";

import { probe, probeColumns, usage } from "@/lib/docker-endpoints";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ endpointId: string }> };

export async function POST(_req: NextRequest, { params }: Params) {
  const { endpointId } = await params;
  const row = await prisma.dockerEndpoint.findUnique({ where: { id: endpointId } });
  if (!row) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const res = await probe(row.host);
  const updated = await prisma.dockerEndpoint.update({
    where: { id: endpointId },
    data: probeColumns(res),
  });
  return NextResponse.json({ ...updated, ...(await usage(endpointId)) });
}
