import { prisma } from "@nexux/db";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

type Params = { params: Promise<{ projectId: string; envVarId: string }> };

/**
 * Both fields are optional so a rename need not retype the secret: the value
 * is masked everywhere and only readable through the `reveal` endpoint, so
 * demanding it back in order to fix a typo in the key would mean revealing a
 * secret just to rename it. At least one field must be present.
 */
const updateSchema = z
  .object({
    key: z
      .string()
      .regex(
        /^[A-Za-z_][A-Za-z0-9_]*$/,
        "Key must be a valid env var name (letters, digits, underscore)",
      )
      .optional(),
    value: z.string().min(1, "Value is required").optional(),
  })
  .refine((d) => d.key !== undefined || d.value !== undefined, {
    message: "Nothing to update",
  });

export async function PUT(req: NextRequest, { params }: Params) {
  const { projectId, envVarId } = await params;
  const parsed = updateSchema.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const existing = await prisma.projectEnvVar.findFirst({
    where: { id: envVarId, projectId },
  });
  if (!existing) {
    return NextResponse.json({ error: "Env var not found" }, { status: 404 });
  }

  const { key, value } = parsed.data;

  // Same uniqueness rule as the create route: SQLite treats NULLs as distinct
  // in unique indexes, so the (projectId, repositoryId, key) collision is
  // caught here. Renaming onto an existing key would otherwise leave two rows
  // exporting the same name, with the winner decided by row order.
  if (key && key !== existing.key) {
    const clash = await prisma.projectEnvVar.findFirst({
      where: { projectId, repositoryId: existing.repositoryId, key },
      select: { id: true },
    });
    if (clash) {
      return NextResponse.json(
        { error: `${key} already exists at this scope` },
        { status: 409 },
      );
    }
  }

  const envVar = await prisma.projectEnvVar.update({
    where: { id: envVarId },
    data: {
      ...(key !== undefined ? { key } : {}),
      ...(value !== undefined ? { value } : {}),
    },
  });

  return NextResponse.json({
    id: envVar.id,
    key: envVar.key,
    repositoryId: envVar.repositoryId,
  });
}

export async function DELETE(_req: NextRequest, { params }: Params) {
  const { projectId, envVarId } = await params;

  const existing = await prisma.projectEnvVar.findFirst({
    where: { id: envVarId, projectId },
  });
  if (!existing) {
    return NextResponse.json({ error: "Env var not found" }, { status: 404 });
  }

  await prisma.projectEnvVar.delete({ where: { id: envVarId } });
  return NextResponse.json({ success: true });
}
