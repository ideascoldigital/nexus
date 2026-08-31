import { NextRequest, NextResponse } from "next/server";
import { getClickUpApp, saveClickUpApp } from "@/services/clickup";
import { clickUpCallbackUrl } from "@/lib/public-origin";
import { z } from "zod";

export const dynamic = "force-dynamic";

const saveSchema = z.object({
  clientId: z.string().min(1, "Client ID is required"),
  clientSecret: z.string().min(1, "Client Secret is required"),
});

/**
 * OAuth app status — the secret never leaves the server. `callbackUrl` is the
 * exact redirect_uri /oauth/start will send, so what Settings tells you to
 * register on the ClickUp app cannot drift from what ClickUp is asked to match.
 */
export async function GET(req: NextRequest) {
  try {
    const app = await getClickUpApp();
    return NextResponse.json({
      configured: app !== null,
      clientId: app?.clientId ?? null,
      callbackUrl: clickUpCallbackUrl(req),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function PUT(req: NextRequest) {
  try {
    const body = await req.json();
    const parsed = saveSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.flatten() },
        { status: 400 }
      );
    }

    await saveClickUpApp(parsed.data.clientId.trim(), parsed.data.clientSecret.trim());
    return NextResponse.json({ configured: true, clientId: parsed.data.clientId.trim() });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
