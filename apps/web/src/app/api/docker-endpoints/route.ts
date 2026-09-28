/**
 * Remote Docker endpoints — list and add. Spec: `specs/26-remote-docker-endpoints.md`.
 *
 * `POST` probes before saving: an endpoint that cannot run a sandbox is not
 * worth a row, and the probe's error is the most useful thing to show while
 * the user still has the dialog open.
 */

import { prisma } from "@nexux/db";
import { describeDockerHostError, parseDockerHost } from "@nexux/sandbox";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import {
  forgetEndpointSsh,
  listEndpoints,
  prepareEndpointSsh,
  probe,
  probeColumns,
} from "@/lib/docker-endpoints";

export const dynamic = "force-dynamic";

const createSchema = z.object({
  name: z.string().trim().min(1, "A name is required").max(60),
  host: z.string(),
});

export async function GET() {
  return NextResponse.json(await listEndpoints());
}

export async function POST(req: NextRequest) {
  const parsed = createSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  const host = parseDockerHost(parsed.data.host);
  if (!host.ok) {
    return NextResponse.json(
      { error: describeDockerHostError(host.error) },
      { status: 400 },
    );
  }

  const existing = await prisma.dockerEndpoint.findUnique({
    where: { host: host.host },
  });
  if (existing) {
    return NextResponse.json(
      { error: `${host.host} is already added as "${existing.name}".` },
      { status: 409 },
    );
  }

  // On a Nexus host the probe's ssh needs the host's key and config first;
  // a refused probe leaves no block behind.
  prepareEndpointSsh(host.host);
  const res = await probe(host.host);
  if (!res.ok) {
    forgetEndpointSsh(host.host);
    return NextResponse.json({ error: res.error }, { status: 400 });
  }

  const row = await prisma.dockerEndpoint.create({
    data: { name: parsed.data.name, host: host.host, ...probeColumns(res) },
  });
  return NextResponse.json({ ...row, sandboxCount: 0, hostCount: 0 }, { status: 201 });
}
