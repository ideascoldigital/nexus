/**
 * Could a sandbox run on this endpoint? (spec 28 phase 5) Runs throwaway
 * busybox containers there and stores the result on the endpoint.
 */

import { prisma } from "@nexux/db";
import { NextRequest, NextResponse } from "next/server";

import { checkEndpointForSandboxes } from "@/lib/credential-checks/docker-endpoint";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ endpointId: string }> };

export async function POST(_req: NextRequest, { params }: Params) {
  const { endpointId } = await params;
  const endpoint = await prisma.dockerEndpoint.findUnique({ where: { id: endpointId } });
  if (!endpoint) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const result = await checkEndpointForSandboxes(endpoint.host);
  await prisma.dockerEndpoint.update({ where: { id: endpointId }, data: { sandboxCheck: result } });
  return NextResponse.json(result);
}
