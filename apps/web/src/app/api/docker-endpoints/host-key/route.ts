/**
 * What a Nexus host shows beside its Docker endpoints (spec 27 phase 6): that
 * it is a host, and the public half of the key it reaches endpoints with — to
 * paste into the target's authorized_keys. The private half never leaves the
 * data volume.
 */

import { NextResponse } from "next/server";

import { hostEndpointKey } from "@/lib/docker-endpoints";

export const dynamic = "force-dynamic";

export async function GET() {
  const key = hostEndpointKey();
  return NextResponse.json({ isHost: key !== null, publicKey: key?.publicKey ?? null });
}
