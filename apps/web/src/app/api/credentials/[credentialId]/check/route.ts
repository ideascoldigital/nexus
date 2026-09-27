/**
 * Test a saved credential and store the result (spec 28).
 *
 * The check talks only to the credential's own provider, and what comes back
 * — stored on the row and returned — never contains the secret.
 */

import { prisma } from "@nexux/db";
import { NextRequest, NextResponse } from "next/server";

import { checkCredential } from "@/lib/credential-checks";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ credentialId: string }> };

export async function POST(_req: NextRequest, { params }: Params) {
  const { credentialId } = await params;
  const cred = await prisma.cloudCredential.findUnique({ where: { id: credentialId } });
  if (!cred) return NextResponse.json({ error: "Credential not found" }, { status: 404 });

  // An AWS check asks about EC2 in the region sandboxes launch in: the one a
  // project using this credential is configured for, when there is one.
  const awsRegion =
    cred.provider === "aws"
      ? ((
          await prisma.sandboxConfig.findFirst({
            where: { credentialId, provider: "aws" },
            select: { region: true },
          })
        )?.region ?? null)
      : null;
  const result = await checkCredential(cred, {}, { awsRegion });
  if (!result) {
    return NextResponse.json(
      { error: `Testing ${cred.provider} credentials isn't available yet.` },
      { status: 422 },
    );
  }
  await prisma.cloudCredential.update({
    where: { id: credentialId },
    data: { lastCheck: result, lastCheckedAt: new Date(result.checkedAt) },
  });
  return NextResponse.json(result);
}
