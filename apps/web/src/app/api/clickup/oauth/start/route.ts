import { NextRequest, NextResponse } from "next/server";
import {
  CLICKUP_AUTHORIZE_URL,
  createOAuthState,
  getClickUpApp,
} from "@/services/clickup";
import { clickUpCallbackUrl, publicOrigin } from "@/lib/public-origin";

export const dynamic = "force-dynamic";

/**
 * Kicks off the OAuth round-trip: 302 to ClickUp's consent screen. The
 * redirect_uri comes from `publicOrigin` — the URL the browser reaches this
 * install on, which is what the Settings card tells you to register on the
 * ClickUp app. It must not come from `req.nextUrl.origin`: see the note in
 * lib/public-origin.ts.
 */
export async function GET(req: NextRequest) {
  try {
    const app = await getClickUpApp();
    if (!app) {
      return NextResponse.redirect(
        new URL(
          "/settings?tab=integrations&clickup_error=ClickUp+OAuth+app+is+not+configured",
          publicOrigin(req)
        )
      );
    }

    const state = await createOAuthState("/settings?tab=integrations");
    const url = new URL(CLICKUP_AUTHORIZE_URL);
    url.searchParams.set("client_id", app.clientId);
    url.searchParams.set("redirect_uri", clickUpCallbackUrl(req));
    url.searchParams.set("state", state);

    return NextResponse.redirect(url);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
