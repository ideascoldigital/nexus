import { NextRequest, NextResponse } from "next/server";
import { GOOGLE_CALLBACK_PATH, googleAuthUrl, pkcePair } from "@/lib/gmail";
import { publicOrigin } from "@/lib/public-origin";
import { createGoogleState, getGoogleApp } from "@/services/google";

export const dynamic = "force-dynamic";

/**
 * The consent URL for one Gmail connection (spec 34). Returned, not
 * redirected to: the app opens it in the user's own browser, because Google
 * refuses to sign in inside an embedded webview. The callback is on this
 * install's loopback origin, which a Desktop OAuth client accepts on any port.
 */
export async function POST(req: NextRequest) {
  const app = await getGoogleApp();
  if (!app) return NextResponse.json({ error: "Set up the Google OAuth app first" }, { status: 409 });
  const body = (await req.json().catch(() => ({}))) as { loginHint?: unknown };
  const redirectUri = new URL(GOOGLE_CALLBACK_PATH, publicOrigin(req)).toString();
  const { verifier, challenge } = pkcePair();
  const state = await createGoogleState(verifier, redirectUri);
  return NextResponse.json({
    url: googleAuthUrl({
      clientId: app.clientId,
      redirectUri,
      state,
      challenge,
      loginHint: typeof body.loginHint === "string" ? body.loginHint : undefined,
    }),
  });
}
