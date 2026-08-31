/**
 * Nexus hosts — list and create. Spec: `specs/19-nexus-host-provisioning.md`.
 *
 * `POST` returns as soon as the row exists; provisioning continues in the
 * background and the client polls. A cloud VM takes minutes to come up, and
 * holding the request open would just time out somewhere less useful.
 */

import { prisma } from "@nexux/db";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { createHost } from "@/lib/host-manager";

export const dynamic = "force-dynamic";

const createSchema = z.object({
  name: z.string().min(1, "A name is required"),
  provider: z.enum(["civo", "aws"]).default("civo"),
  credentialId: z.string().optional().nullable(),
  tailscaleCredentialId: z.string().optional().nullable(),
  registryCredentialId: z.string().optional().nullable(),
  region: z.string().min(1),
  size: z.string().min(1),
  diskImage: z.string().optional(),
  imageRef: z.string().optional(),
  pullEmbeddingModel: z.boolean().default(true),
  setupScript: z.string().optional().nullable(),
});

export async function GET() {
  const hosts = await prisma.nexusHost.findMany({
    where: { status: { not: "destroyed" } },
    orderBy: { createdAt: "desc" },
    // The log can be large and the list polls; the detail route serves it.
    select: {
      id: true,
      name: true,
      status: true,
      provider: true,
      region: true,
      size: true,
      instanceId: true,
      publicIp: true,
      tailscaleIp: true,
      tailscaleName: true,
      imageRef: true,
      error: true,
      createdAt: true,
      updatedAt: true,
    },
  });
  return NextResponse.json(hosts);
}

export async function POST(req: NextRequest) {
  const parsed = createSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  try {
    const host = await createHost(parsed.data);
    return NextResponse.json(host, { status: 201 });
  } catch (err) {
    // Every failure here is a precondition the user can act on — no terraform
    // has run yet — so the message goes back verbatim rather than as a 500.
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Could not create the host" },
      { status: 400 },
    );
  }
}
