/**
 * Make a file already on this machine a project's seed (spec 29) — no upload,
 * no size cap. Refused unless the request comes from this machine: the
 * server reads the path, so on a Nexus host or over the network it would be
 * reading a disk the person is not looking at.
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { canPickLocalFile } from "@/lib/seed/local-pick";
import { ingestSeedFromPath, SeedError } from "@/lib/seed/store";

export const dynamic = "force-dynamic";
export const maxDuration = 3600;

type Params = { params: Promise<{ projectId: string }> };

const bodySchema = z.object({
  nodeId: z.string().min(1),
  path: z.string().min(1),
  sensitive: z.boolean().default(true),
});

export async function POST(req: NextRequest, { params }: Params) {
  const { projectId } = await params;
  if (!canPickLocalFile(req)) {
    return NextResponse.json({ error: "Picking a file by path only works on the machine running Nexux. Upload it instead." }, { status: 403 });
  }
  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  try {
    const seed = await ingestSeedFromPath({
      projectId,
      stackNodeId: parsed.data.nodeId,
      filePath: parsed.data.path.trim().replace(/^~(?=\/)/, process.env.HOME ?? "~"),
      sensitive: parsed.data.sensitive,
    });
    return NextResponse.json(seed, { status: 201 });
  } catch (err) {
    if (err instanceof SeedError) return NextResponse.json({ error: err.message }, { status: err.status });
    throw err;
  }
}
