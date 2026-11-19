/**
 * A project's seed data (spec 29): list, and upload one for a stack service.
 *
 * The upload is the raw file as the request body, streamed to disk — never
 * multipart, never buffered whole — so a multi-GB dump costs memory for one
 * chunk. The service and the name ride in the query string.
 */

import { Readable } from "stream";
import type { ReadableStream as WebReadableStream } from "stream/web";
import { NextRequest, NextResponse } from "next/server";

import { canPickLocalFile } from "@/lib/seed/local-pick";
import { ingestSeed, listSeeds, SeedError, seedMaxBytes } from "@/lib/seed/store";

export const dynamic = "force-dynamic";
export const maxDuration = 3600;

type Params = { params: Promise<{ projectId: string }> };

export async function GET(req: NextRequest, { params }: Params) {
  const { projectId } = await params;
  return NextResponse.json({
    seeds: await listSeeds(projectId),
    canPickLocalFile: canPickLocalFile(req),
    maxUploadBytes: seedMaxBytes(),
  });
}

export async function POST(req: NextRequest, { params }: Params) {
  const { projectId } = await params;
  const q = req.nextUrl.searchParams;
  const stackNodeId = q.get("nodeId");
  const fileName = q.get("fileName");
  if (!stackNodeId || !fileName || !req.body) {
    return NextResponse.json({ error: "nodeId, fileName and a file body are required" }, { status: 400 });
  }
  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > seedMaxBytes()) {
    return NextResponse.json({ error: "The file is larger than the upload limit. Pick it from this machine instead, or raise NEXUX_SEED_MAX_BYTES." }, { status: 413 });
  }
  try {
    const seed = await ingestSeed({
      projectId,
      stackNodeId,
      fileName,
      sensitive: q.get("sensitive") !== "false",
      source: Readable.fromWeb(req.body as unknown as WebReadableStream),
      maxBytes: seedMaxBytes(),
    });
    return NextResponse.json(seed, { status: 201 });
  } catch (err) {
    if (err instanceof SeedError) return NextResponse.json({ error: err.message }, { status: err.status });
    throw err;
  }
}
