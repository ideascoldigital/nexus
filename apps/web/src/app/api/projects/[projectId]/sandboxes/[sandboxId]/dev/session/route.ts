import { prisma } from "@nexux/db";
import { NextRequest, NextResponse } from "next/server";
import { resetDevSession } from "@/lib/dev-console";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ projectId: string; sandboxId: string }> };

/** Reset the continuous Claude session and wipe the chat history. */
export async function DELETE(_req: NextRequest, { params }: Params) {
  const { projectId, sandboxId } = await params;

  const sandbox = await prisma.sandbox.findFirst({
    where: { id: sandboxId, projectId },
    select: { id: true },
  });
  if (!sandbox) {
    return NextResponse.json({ error: "Sandbox not found" }, { status: 404 });
  }

  await resetDevSession(sandboxId);
  return NextResponse.json({ reset: true });
}
