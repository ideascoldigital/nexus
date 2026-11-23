import { NextResponse } from "next/server";

import { listConnectors } from "@/services/connector-store";

export const dynamic = "force-dynamic";

/** Every catalog app with whether it is connected (spec 35). No secrets. */
export async function GET() {
  return NextResponse.json(await listConnectors());
}
