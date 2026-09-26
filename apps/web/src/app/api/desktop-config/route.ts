/**
 * The desktop app's data location — `~/.nexux/native.json`, read and written.
 * See lib/desktop-config.ts for the contract it shares with the Rust shell.
 *
 * Takes effect the next time the desktop app launches: the shell reads the
 * file once, before the server it spawns exists.
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { readDesktopConfig, writeDesktopConfig } from "@/lib/desktop-config";

export const dynamic = "force-dynamic";

const putSchema = z.object({
  databasePath: z.string().optional(),
  dataDir: z.string().optional(),
});

/**
 * JSON only. This route decides which database the desktop app opens, and a
 * JSON content type forces a CORS preflight — which this server never
 * answers — so a web page cannot fire it at localhost from the user's browser.
 */
function isJson(req: NextRequest): boolean {
  return (req.headers.get("content-type") ?? "").startsWith("application/json");
}

export async function GET() {
  return NextResponse.json(readDesktopConfig());
}

export async function PUT(req: NextRequest) {
  if (!isJson(req)) {
    return NextResponse.json({ error: "Expected application/json" }, { status: 415 });
  }
  const parsed = putSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  const res = writeDesktopConfig(parsed.data);
  if (!res.ok) return NextResponse.json({ error: res.error }, { status: 400 });
  return NextResponse.json(readDesktopConfig());
}

/** Back to the defaults: removes the file. */
export async function DELETE(req: NextRequest) {
  if (!isJson(req)) {
    return NextResponse.json({ error: "Expected application/json" }, { status: 415 });
  }
  writeDesktopConfig({});
  return NextResponse.json(readDesktopConfig());
}
