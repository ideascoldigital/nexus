import { prisma } from "@nexux/db";
import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ credentialId: string }> };

export async function DELETE(_req: NextRequest, { params }: Params) {
  const { credentialId } = await params;
  const cred = await prisma.cloudCredential.findUnique({
    where: { id: credentialId },
  });
  if (!cred) {
    return NextResponse.json({ error: "Credential not found" }, { status: 404 });
  }
  // Block deletion while a live sandbox still needs it for terraform destroy.
  const inUse = await prisma.sandbox.count({
    where: { credentialId, status: { notIn: ["destroyed"] } },
  });
  if (inUse > 0) {
    return NextResponse.json(
      {
        error: `Credential is used by ${inUse} active sandbox${inUse !== 1 ? "es" : ""} — destroy them first.`,
      },
      { status: 409 },
    );
  }
  await prisma.cloudCredential.delete({ where: { id: credentialId } });
  return NextResponse.json({ ok: true });
}
