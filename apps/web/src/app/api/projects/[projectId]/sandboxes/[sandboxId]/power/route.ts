import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { pauseSandbox, resumeSandbox } from "@/lib/sandbox-manager";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ projectId: string; sandboxId: string }> };

const schema = z.object({ action: z.enum(["pause", "resume"]) });

/** Docker-only power control: stop/start the sandbox container. */
export async function POST(req: NextRequest, { params }: Params) {
  const { sandboxId } = await params;
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }
  try {
    const sandbox =
      parsed.data.action === "pause"
        ? await pauseSandbox(sandboxId)
        : await resumeSandbox(sandboxId);
    return NextResponse.json(sandbox);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Power action failed";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
