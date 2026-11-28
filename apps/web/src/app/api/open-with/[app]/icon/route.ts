import { execFile } from "child_process";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { promisify } from "util";
import { NextResponse } from "next/server";

import { iconFileIn, macAppBundle, OPENERS, type OpenerId } from "@/lib/open-with";

export const dynamic = "force-dynamic";

const run = promisify(execFile);
const cache = new Map<OpenerId, Buffer | null>();

/** The installed app's own icon as a 64px PNG (macOS only; 404 elsewhere, and the UI draws its own). */
async function iconPng(id: OpenerId): Promise<Buffer | null> {
  if (process.platform !== "darwin") return null;
  const bundle = macAppBundle(id);
  if (!bundle) return null;
  const iconName = await run("plutil", ["-extract", "CFBundleIconFile", "raw", path.join(bundle, "Contents", "Info.plist")])
    .then((r) => r.stdout.trim() || null)
    .catch(() => null);
  const icns = iconFileIn(bundle, iconName);
  if (!icns) return null;
  const out = path.join(os.tmpdir(), `nexux-opener-${id}-${process.pid}.png`);
  try {
    await run("sips", ["-s", "format", "png", "-Z", "64", icns, "--out", out]);
    return await fs.readFile(out);
  } catch {
    return null;
  } finally {
    await fs.unlink(out).catch(() => {});
  }
}

export async function GET(_req: Request, { params }: { params: Promise<{ app: string }> }) {
  const { app } = await params;
  if (!OPENERS.includes(app as OpenerId)) return NextResponse.json({ error: "Unknown app" }, { status: 404 });
  const id = app as OpenerId;
  if (!cache.has(id)) cache.set(id, await iconPng(id));
  const png = cache.get(id);
  if (!png) return NextResponse.json({ error: "No icon" }, { status: 404 });
  return new NextResponse(new Uint8Array(png), {
    headers: { "Content-Type": "image/png", "Cache-Control": "public, max-age=86400" },
  });
}
