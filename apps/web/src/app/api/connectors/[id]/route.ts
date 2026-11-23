import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { ConnectorError, removeConnector, saveConnector, setConnectorBots } from "@/services/connector-store";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

const botIds = z.array(z.string().min(1).max(64)).max(200).nullable();
const putSchema = z.object({
  values: z.record(z.string(), z.union([z.string().max(4000), z.boolean()])),
  botIds: botIds.optional(),
});

/** Connect an app, or update what it was connected with (an empty secret keeps the stored one). */
export async function PUT(req: NextRequest, { params }: Params) {
  const { id } = await params;
  const parsed = putSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "values are required" }, { status: 400 });
  try {
    await saveConnector(id, parsed.data.values, parsed.data.botIds);
    return NextResponse.json({ ok: true });
  } catch (err) {
    if (err instanceof ConnectorError) return NextResponse.json({ error: err.message }, { status: err.status });
    throw err;
  }
}

/** Which bots may use it. */
export async function PATCH(req: NextRequest, { params }: Params) {
  const { id } = await params;
  const parsed = z.object({ botIds }).safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "botIds is required" }, { status: 400 });
  if (!(await setConnectorBots(id, parsed.data.botIds))) return NextResponse.json({ error: "Not connected" }, { status: 404 });
  return NextResponse.json({ ok: true });
}

/** Disconnect: Nexus forgets the token; bots lose the app on their next message. */
export async function DELETE(_req: NextRequest, { params }: Params) {
  const { id } = await params;
  if (!(await removeConnector(id))) return NextResponse.json({ error: "Not connected" }, { status: 404 });
  return NextResponse.json({ ok: true });
}
