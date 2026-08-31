import { prisma } from "@nexux/db";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requestDestroy } from "@/lib/sandbox-manager";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ projectId: string; sandboxId: string }> };

const patchSchema = z.object({
  dedicated: z.boolean().optional(),
  muteTelegram: z.boolean().optional(),
  muteSlack: z.boolean().optional(),
});

export async function PATCH(req: NextRequest, { params }: Params) {
  const { projectId, sandboxId } = await params;

  const parsed = patchSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }

  const sandbox = await prisma.sandbox.findFirst({
    where: { id: sandboxId, projectId },
  });
  if (!sandbox) {
    return NextResponse.json({ error: "Sandbox not found" }, { status: 404 });
  }

  const data: {
    dedicated?: boolean;
    ephemeral?: boolean;
    muteTelegram?: boolean;
    muteSlack?: boolean;
  } =
    { ...parsed.data };
  // A dev sandbox must outlive its tasks — dedicating one clears ephemeral.
  if (parsed.data.dedicated) data.ephemeral = false;

  const updated = await prisma.sandbox.update({
    where: { id: sandboxId },
    data,
  });

  // A sandbox just became the dev sandbox — features parked in the board's
  // Queue column can dispatch now.
  if (parsed.data.dedicated) {
    const { flushFeatureQueue } = await import("@/lib/dev-console");
    void flushFeatureQueue(projectId).catch(() => undefined);
  }

  return NextResponse.json(updated);
}

export async function GET(_req: NextRequest, { params }: Params) {
  const { projectId, sandboxId } = await params;

  const sandbox = await prisma.sandbox.findFirst({
    where: { id: sandboxId, projectId },
  });
  if (!sandbox) {
    return NextResponse.json({ error: "Sandbox not found" }, { status: 404 });
  }

  return NextResponse.json(sandbox);
}

export async function DELETE(_req: NextRequest, { params }: Params) {
  const { projectId, sandboxId } = await params;

  const sandbox = await prisma.sandbox.findFirst({
    where: { id: sandboxId, projectId },
  });
  if (!sandbox) {
    return NextResponse.json({ error: "Sandbox not found" }, { status: 404 });
  }

  // Already-destroyed sandboxes have no infrastructure left — DELETE just
  // hides the record. Archiving (not deleting) keeps its SandboxTask history
  // and PR links alive; a hard delete used to cascade them away.
  if (sandbox.status === "destroyed") {
    await prisma.sandbox.update({
      where: { id: sandboxId },
      data: { archived: true },
    });
    return NextResponse.json({ deleted: true });
  }

  try {
    const updated = await requestDestroy(sandboxId);
    return NextResponse.json(updated, { status: 202 });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Destroy failed";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
