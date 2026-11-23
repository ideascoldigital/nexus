/**
 * Open a URL in the user's default browser — native app only.
 *
 * The Tauri webview does nothing with target="_blank" (it never creates
 * windows), and the web UI deliberately has no Tauri JS API — the sidecar is
 * the app's only bridge to the machine. Since the sidecar runs locally as the
 * user, it can hand the URL to the OS opener itself. Browser installs answer
 * 404 and the client falls back to window.open, which works there.
 *
 * `pnpm dev:native` sets NEXUX_OPEN_URL=1: the same webview, without the
 * packaged-only routes (self-install) that NEXUX_NATIVE also turns on.
 *
 * http(s) only: the OS opener would happily run file:, and this endpoint is
 * reachable by anything that can reach the sidecar port.
 */

import { spawn } from "child_process";

import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/** Opener argv per platform. Pure and exported for tests. */
export function openerCommand(
  platform: NodeJS.Platform,
  url: string,
): string[] {
  if (platform === "darwin") return ["open", url];
  if (platform === "win32") return ["cmd", "/c", "start", "", url];
  return ["xdg-open", url];
}

export function validateUrl(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return url.toString();
  } catch {
    return null;
  }
}

export async function POST(req: Request) {
  if (process.env.NEXUX_NATIVE !== "1" && process.env.NEXUX_OPEN_URL !== "1") {
    return NextResponse.json(
      { error: "open-url is only available in the native app" },
      { status: 404 },
    );
  }
  const body = (await req.json().catch(() => ({}))) as { url?: unknown };
  const url = validateUrl(body.url);
  if (!url) {
    return NextResponse.json(
      { error: "url must be a valid http(s) URL" },
      { status: 400 },
    );
  }
  const [cmd, ...args] = openerCommand(process.platform, url);
  spawn(cmd, args, { detached: true, stdio: "ignore" }).unref();
  return NextResponse.json({ ok: true });
}
