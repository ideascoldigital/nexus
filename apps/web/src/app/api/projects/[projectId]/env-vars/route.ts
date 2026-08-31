import { prisma } from "@nexux/db";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

type Params = { params: Promise<{ projectId: string }> };

const envVarSchema = z.object({
  key: z
    .string()
    .regex(
      /^[A-Za-z_][A-Za-z0-9_]*$/,
      "Key must be a valid env var name (letters, digits, underscore)",
    ),
  value: z.string().min(1, "Value is required"),
  repositoryId: z.string().optional().nullable(),
});

export async function POST(req: NextRequest, { params }: Params) {
  const { projectId } = await params;
  const parsed = envVarSchema.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const { key, value } = parsed.data;
  const repositoryId = parsed.data.repositoryId || null;

  if (repositoryId) {
    const repo = await prisma.repository.findFirst({
      where: { id: repositoryId, projectId },
    });
    if (!repo) {
      return NextResponse.json(
        { error: "Repository not found in this project" },
        { status: 400 },
      );
    }
  }

  // Upsert by (projectId, repositoryId, key) — SQLite treats NULLs as
  // distinct in unique indexes, so enforce uniqueness here instead.
  const existing = await prisma.projectEnvVar.findFirst({
    where: { projectId, repositoryId, key },
  });

  const envVar = existing
    ? await prisma.projectEnvVar.update({
        where: { id: existing.id },
        data: { value },
      })
    : await prisma.projectEnvVar.create({
        data: { projectId, repositoryId, key, value },
      });

  return NextResponse.json(
    { id: envVar.id, key: envVar.key, repositoryId: envVar.repositoryId },
    { status: existing ? 200 : 201 },
  );
}
