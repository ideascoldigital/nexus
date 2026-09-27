/** Global assistant threads (spec 30): list and create. */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { createThread, listThreads } from "@/lib/assistant/threads";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({ threads: await listThreads() });
}

const bodySchema = z.object({ projectId: z.string().min(1).nullable().optional() });

export async function POST(req: NextRequest) {
  const parsed = bodySchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  return NextResponse.json(await createThread({ projectId: parsed.data.projectId ?? null }), { status: 201 });
}
