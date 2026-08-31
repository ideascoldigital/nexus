/**
 * What the create form needs to explain, before it is filled in, why Create is
 * disabled: terraform present, a cloud credential, a Tailscale auth key.
 *
 * Mirrors the sandbox tab's readiness endpoint. Deliberately does not probe the
 * registry — that would cost a network round trip on every page load, and an
 * unreachable image is reported at creation with a clearer message.
 */

import { NextResponse } from "next/server";

import { DEFAULT_HOST_IMAGE, getHostReadiness } from "@/lib/host-manager";

export const dynamic = "force-dynamic";

export async function GET() {
  const readiness = await getHostReadiness();
  return NextResponse.json({ ...readiness, defaultImage: DEFAULT_HOST_IMAGE });
}
