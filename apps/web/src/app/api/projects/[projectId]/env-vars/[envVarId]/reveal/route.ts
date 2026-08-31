import { prisma } from "@nexux/db";
import { NextRequest, NextResponse } from "next/server";

type Params = { params: Promise<{ projectId: string; envVarId: string }> };

/**
 * Plaintext value for a single env var — fetched only when the user clicks
 * "reveal" or "copy". Deliberately not part of the /setup payload so secrets
 * don't ride along with every panel load (or sit in the React Query cache).
 */
export async function GET(_req: NextRequest, { params }: Params) {
  const { projectId, envVarId } = await params;

  const envVar = await prisma.projectEnvVar.findFirst({
    where: { id: envVarId, projectId },
    select: { id: true, key: true, value: true },
  });
  if (!envVar) {
    return NextResponse.json({ error: "Env var not found" }, { status: 404 });
  }

  return NextResponse.json(envVar, {
    headers: { "Cache-Control": "no-store" },
  });
}
