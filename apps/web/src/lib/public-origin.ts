import type { NextRequest } from "next/server";

/**
 * The origin a browser actually uses to reach this install.
 *
 * `req.nextUrl.origin` is *not* that. Next's standalone server builds request
 * URLs from the address it bound to, not from the Host header, so inside the
 * Docker image (`HOSTNAME=0.0.0.0`) every route sees `http://0.0.0.0:3030`
 * regardless of how the browser got here. Handing that value to a third party
 * — an OAuth `redirect_uri` above all — produces a URL that resolves nowhere
 * and the provider rejects the round-trip.
 *
 * `NEXUX_WEB_ORIGIN` is already defined as "the URL you actually open the
 * dashboard on" (docs/DEPLOYMENT.md; it is the terminal server's CORS origin,
 * and host provisioning sets it to the Tailscale URL), so it wins here too.
 * Behind a reverse proxy that sets `X-Forwarded-*` we trust those instead, and
 * only then fall back to Next's own view of the request — correct in `pnpm dev`,
 * where the server binds to the same host the browser uses.
 */
export function publicOrigin(req: NextRequest): string {
  const configured = process.env.NEXUX_WEB_ORIGIN?.trim();
  if (configured) return configured.replace(/\/+$/, "");

  const host =
    req.headers.get("x-forwarded-host")?.split(",")[0].trim() ||
    req.headers.get("host")?.trim();
  if (host) {
    const proto =
      req.headers.get("x-forwarded-proto")?.split(",")[0].trim() ||
      req.nextUrl.protocol.replace(":", "");
    return `${proto}://${host}`;
  }

  return req.nextUrl.origin;
}

/** The ClickUp OAuth callback URL — must match what is registered on the app. */
export function clickUpCallbackUrl(req: NextRequest): string {
  return new URL("/api/clickup/oauth/callback", publicOrigin(req)).toString();
}
