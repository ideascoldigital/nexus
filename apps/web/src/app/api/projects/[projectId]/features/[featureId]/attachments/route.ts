import { prisma, Prisma } from "@nexux/db";
import { NextRequest, NextResponse } from "next/server";
import { rename, rm } from "fs/promises";
import path from "path";
import {
  stageDevAttachments,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENT_COUNT,
  type DevAttachment,
} from "@/lib/dev-console";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ projectId: string; featureId: string }> };

async function findFeature(projectId: string, featureId: string) {
  return prisma.feature.findFirst({ where: { id: featureId, projectId } });
}

const toClient = (a: DevAttachment) => ({
  name: a.name,
  mime: a.mime,
  size: a.size,
});

/**
 * Attach files to a feature (multipart, field "files"). They stage on the
 * host and are pushed into the sandbox when the feature is dispatched —
 * kanban queue → dev sandbox, or the PR pipeline. Host paths stay server-side.
 */
export async function POST(req: NextRequest, { params }: Params) {
  const { projectId, featureId } = await params;
  const feature = await findFeature(projectId, featureId);
  if (!feature) {
    return NextResponse.json({ error: "Feature not found" }, { status: 404 });
  }

  const form = await req.formData().catch(() => null);
  const entries = (form?.getAll("files") ?? []).filter(
    (f): f is File => f instanceof File && f.size > 0,
  );
  if (entries.length === 0) {
    return NextResponse.json({ error: "No files provided" }, { status: 400 });
  }

  const existing = (feature.attachments as DevAttachment[] | null) ?? [];
  if (existing.length + entries.length > MAX_ATTACHMENT_COUNT) {
    return NextResponse.json(
      { error: `Max ${MAX_ATTACHMENT_COUNT} attachments per feature` },
      { status: 400 },
    );
  }
  const total =
    existing.reduce((n, a) => n + a.size, 0) +
    entries.reduce((n, f) => n + f.size, 0);
  if (total > MAX_ATTACHMENT_BYTES) {
    return NextResponse.json(
      {
        error: `Attachments too large (max ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB per feature)`,
      },
      { status: 400 },
    );
  }

  try {
    const staged = await stageDevAttachments(
      await Promise.all(
        entries.map(async (f) => ({
          name: f.name,
          mime: f.type,
          data: Buffer.from(await f.arrayBuffer()),
        })),
      ),
    );
    // Same name twice across batches: keep both — rename the new file on
    // disk too, so the pushed remote path always matches the metadata.
    const used = new Set(existing.map((a) => a.name));
    for (const a of staged) {
      let name = a.name;
      for (let i = 2; used.has(name); i++) {
        const dot = name.lastIndexOf(".");
        name =
          dot > 0
            ? `${name.slice(0, dot)}-${i}${name.slice(dot)}`
            : `${name}-${i}`;
      }
      used.add(name);
      if (name !== a.name) {
        const next = path.join(path.dirname(a.path), name);
        await rename(a.path, next);
        a.path = next;
        a.name = name;
      }
    }
    const attachments = [...existing, ...staged];
    await prisma.feature.update({
      where: { id: featureId },
      data: { attachments: attachments as unknown as Prisma.InputJsonValue },
    });
    return NextResponse.json({ attachments: attachments.map(toClient) });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Upload failed";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

/** Remove one attachment by name (?name=...) — file and metadata. */
export async function DELETE(req: NextRequest, { params }: Params) {
  const { projectId, featureId } = await params;
  const feature = await findFeature(projectId, featureId);
  if (!feature) {
    return NextResponse.json({ error: "Feature not found" }, { status: 404 });
  }
  const name = new URL(req.url).searchParams.get("name");
  if (!name) {
    return NextResponse.json({ error: "name is required" }, { status: 400 });
  }

  const existing = (feature.attachments as DevAttachment[] | null) ?? [];
  const target = existing.find((a) => a.name === name);
  if (!target) {
    return NextResponse.json({ error: "Attachment not found" }, { status: 404 });
  }
  // Targeted delete of the staged file only — never a directory wipe.
  await rm(target.path, { force: true }).catch(() => undefined);
  const attachments = existing.filter((a) => a.name !== name);
  await prisma.feature.update({
    where: { id: featureId },
    data: {
      attachments: attachments.length
        ? (attachments as unknown as Prisma.InputJsonValue)
        : Prisma.DbNull,
    },
  });
  return NextResponse.json({ attachments: attachments.map(toClient) });
}
