import fs from "node:fs";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";

import { botFilesDir, contentTypeFor } from "@/lib/bot-files";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ botId: string; runId: string; name: string }> };

const SEGMENT = /^[\w-]+$/;

/**
 * A file a bot handed the user, copied out of its computer when the reply
 * came in. Served sandboxed: an SVG or HTML from a bot never runs script in
 * Nexus's origin, even when opened directly.
 */
export async function GET(_req: NextRequest, { params }: Params) {
  const { botId, runId, name } = await params;
  const file = decodeURIComponent(name);
  if (!SEGMENT.test(botId) || !SEGMENT.test(runId) || file.includes("/") || file.startsWith(".")) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const dir = botFilesDir(botId, runId);
  const full = path.resolve(dir, file);
  if (!full.startsWith(dir + path.sep) || !fs.existsSync(full) || !fs.statSync(full).isFile()) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  return new NextResponse(fs.readFileSync(full), {
    headers: {
      "Content-Type": contentTypeFor(file),
      "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(file)}`,
      "Content-Security-Policy": "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox",
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "private, max-age=31536000, immutable",
    },
  });
}
