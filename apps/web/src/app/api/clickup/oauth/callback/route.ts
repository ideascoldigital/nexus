import { NextRequest, NextResponse } from "next/server";
import {
  connectClickUpAccount,
  consumeOAuthState,
  exchangeCodeForToken,
} from "@/services/clickup";
import { publicOrigin } from "@/lib/public-origin";

export const dynamic = "force-dynamic";

/**
 * ClickUp redirects here with ?code=&state=. Everything ends in a redirect
 * back to Settings — success and failure are both surfaced there as toasts,
 * never as a bare JSON page in the middle of a browser flow.
 */
export async function GET(req: NextRequest) {
  const settingsUrl = (params: Record<string, string>) => {
    const url = new URL("/settings", publicOrigin(req));
    url.searchParams.set("tab", "integrations");
    Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
    return url;
  };

  try {
    const code = req.nextUrl.searchParams.get("code");
    const state = req.nextUrl.searchParams.get("state");
    if (!state) {
      return NextResponse.redirect(
        settingsUrl({ clickup_error: "Missing OAuth state" })
      );
    }

    await consumeOAuthState(state);

    if (!code) {
      // The user cancelled on ClickUp's consent screen.
      return NextResponse.redirect(
        settingsUrl({ clickup_error: "Authorization was cancelled" })
      );
    }

    const accessToken = await exchangeCodeForToken(code);
    await connectClickUpAccount(accessToken);

    return NextResponse.redirect(settingsUrl({ clickup: "connected" }));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // The browser only sees a redirect — without this line a failed exchange
    // leaves no trace anywhere.
    console.error("[clickup] oauth callback failed:", message);
    return NextResponse.redirect(settingsUrl({ clickup_error: message }));
  }
}
