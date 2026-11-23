import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { looksLikeClientId } from "@/lib/gmail";
import { getGoogleApp, saveGoogleApp } from "@/services/google";

export const dynamic = "force-dynamic";

/** Whether the Google OAuth app is set up (spec 34). The secret never comes back. */
export async function GET() {
  const app = await getGoogleApp();
  return NextResponse.json({ configured: Boolean(app), clientId: app?.clientId ?? null });
}

const schema = z.object({ clientId: z.string().trim().min(1), clientSecret: z.string().trim().min(1) });

export async function PUT(req: NextRequest) {
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "The client ID and the client secret are both required" }, { status: 400 });
  if (!looksLikeClientId(parsed.data.clientId)) {
    return NextResponse.json({ error: "That doesn't look like a Google client ID (…apps.googleusercontent.com)" }, { status: 400 });
  }
  await saveGoogleApp(parsed.data.clientId, parsed.data.clientSecret);
  return NextResponse.json({ configured: true, clientId: parsed.data.clientId });
}
