import { prisma } from "@nexux/db";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

type Params = { params: Promise<{ projectId: string }> };

const fromStackSchema = z.object({
  nodeId: z.string().min(1),
  /** Subset of the node's keys to copy; omitted means all of them. */
  keys: z.array(z.string().min(1)).optional(),
  repositoryId: z.string().optional().nullable(),
  overwrite: z.boolean().default(true),
});

const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Copy env vars from a Stack canvas node into the project's env vars.
 *
 * A copy, not a live reference: once imported the values are independent, so
 * editing them here never writes back to the stack (D-20 keeps the canvas the
 * source of truth for how a node *runs*, not for sandbox secrets).
 */
export async function POST(req: NextRequest, { params }: Params) {
  const { projectId } = await params;
  const parsed = fromStackSchema.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const { nodeId, keys, overwrite } = parsed.data;
  const repositoryId = parsed.data.repositoryId || null;

  const node = await prisma.stackNode.findFirst({
    where: { id: nodeId, projectId },
    select: { env: true, name: true },
  });
  if (!node) {
    return NextResponse.json(
      { error: "Stack node not found in this project" },
      { status: 404 },
    );
  }

  if (repositoryId) {
    const repo = await prisma.repository.findFirst({
      where: { id: repositoryId, projectId },
      select: { id: true },
    });
    if (!repo) {
      return NextResponse.json(
        { error: "Repository not found in this project" },
        { status: 400 },
      );
    }
  }

  const wanted = keys ? new Set(keys) : null;
  const raw = Array.isArray(node.env) ? node.env : [];
  const entries = raw.flatMap((row) => {
    if (!row || typeof row !== "object") return [];
    const { key, value } = row as { key?: unknown; value?: unknown };
    if (typeof key !== "string" || !ENV_KEY_RE.test(key)) return [];
    if (wanted && !wanted.has(key)) return [];
    return [{ key, value: typeof value === "string" ? value : "" }];
  });

  if (entries.length === 0) {
    return NextResponse.json(
      { error: `No importable env vars on "${node.name}"` },
      { status: 400 },
    );
  }

  const existing = await prisma.projectEnvVar.findMany({
    where: { projectId, repositoryId, key: { in: entries.map((e) => e.key) } },
    select: { id: true, key: true },
  });
  const existingByKey = new Map(existing.map((row) => [row.key, row.id]));

  const created: string[] = [];
  const updated: string[] = [];
  const skipped: string[] = [];

  for (const entry of entries) {
    const existingId = existingByKey.get(entry.key);
    if (existingId) {
      if (!overwrite) {
        skipped.push(entry.key);
        continue;
      }
      await prisma.projectEnvVar.update({
        where: { id: existingId },
        data: { value: entry.value },
      });
      updated.push(entry.key);
    } else {
      await prisma.projectEnvVar.create({
        data: { projectId, repositoryId, key: entry.key, value: entry.value },
      });
      created.push(entry.key);
    }
  }

  return NextResponse.json({ created, updated, skipped });
}
