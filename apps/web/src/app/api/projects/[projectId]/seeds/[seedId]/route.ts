import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { deleteSeed, SeedError, updateSeed } from "@/lib/seed/store";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ projectId: string; seedId: string }> };

const patchSchema = z
  .object({ sensitive: z.boolean().optional(), enabled: z.boolean().optional() })
  .strict();

export async function PATCH(req: NextRequest, { params }: Params) {
  const { projectId, seedId } = await params;
  const parsed = patchSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  try {
    return NextResponse.json(await updateSeed(projectId, seedId, parsed.data));
  } catch (err) {
    if (err instanceof SeedError) return NextResponse.json({ error: err.message }, { status: err.status });
    throw err;
  }
}

/** Removes the row and the file. */
export async function DELETE(_req: NextRequest, { params }: Params) {
  const { projectId, seedId } = await params;
  try {
    await deleteSeed(projectId, seedId);
    return new NextResponse(null, { status: 204 });
  } catch (err) {
    if (err instanceof SeedError) return NextResponse.json({ error: err.message }, { status: err.status });
    throw err;
  }
}
