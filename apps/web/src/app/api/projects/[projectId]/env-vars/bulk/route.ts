import { prisma } from "@nexux/db";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { parseDotenvWithDiagnostics } from "@/lib/stack/dotenv";

type Params = { params: Promise<{ projectId: string }> };

const bulkSchema = z.object({
  /** Raw pasted `.env` text — re-parsed here rather than trusting the client. */
  content: z.string().min(1, "Nothing to import"),
  repositoryId: z.string().optional().nullable(),
  /** When false, keys that already exist at this scope are left untouched. */
  overwrite: z.boolean().default(true),
});

export async function POST(req: NextRequest, { params }: Params) {
  const { projectId } = await params;
  const parsed = bulkSchema.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const { content, overwrite } = parsed.data;
  const repositoryId = parsed.data.repositoryId || null;

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

  const parsedEnv = parseDotenvWithDiagnostics(content);
  const invalidLines = [...parsedEnv.invalidLines];
  // The parser accepts `.` and `-` in keys (compose-style); a shell env var
  // cannot hold them, and the single-var route rejects them too. Report rather
  // than silently storing something no sandbox can export.
  const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
  const entries = parsedEnv.entries.filter((e) => {
    if (ENV_KEY_RE.test(e.key)) return true;
    invalidLines.push({ line: 0, text: `${e.key} — not a valid env var name` });
    return false;
  });
  if (entries.length === 0) {
    return NextResponse.json(
      { error: "No valid KEY=value pairs found", invalidLines },
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

  // Sequential rather than a single transaction: SQLite serialises writes
  // anyway, and a partial import stays useful if one row trips a constraint.
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

  return NextResponse.json({
    created,
    updated,
    skipped,
    invalidLines,
  });
}
