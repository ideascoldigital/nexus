import { prisma } from "@nexux/db";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import fs from "node:fs/promises";
import matter from "gray-matter";

const updateSkillSchema = z.object({
  description: z.string().nullable().optional(),
  body: z.string().optional(),
});

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ skillId: string }> },
) {
  const { skillId } = await params;
  const skill = await prisma.skill.findUnique({
    where: { id: skillId },
    include: { _count: { select: { projectSkills: true } } },
  });
  if (!skill) {
    return NextResponse.json({ error: "Skill not found" }, { status: 404 });
  }
  return NextResponse.json(skill);
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ skillId: string }> },
) {
  const { skillId } = await params;
  const existing = await prisma.skill.findUnique({ where: { id: skillId } });
  if (!existing) {
    return NextResponse.json({ error: "Skill not found" }, { status: 404 });
  }
  if (existing.isBuiltIn) {
    return NextResponse.json(
      { error: "Built-in skills cannot be edited" },
      { status: 403 },
    );
  }

  const body = await req.json();
  const parsed = updateSkillSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { message: "Invalid skill data", error: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const newDescription =
    parsed.data.description !== undefined
      ? parsed.data.description
      : existing.description;
  const newBody = parsed.data.body !== undefined ? parsed.data.body : existing.body;

  // Rewrite SKILL.md if there is a disk path.
  if (existing.path) {
    const frontmatter = {
      name: existing.name,
      description: newDescription ?? "",
    };
    const content = matter.stringify(newBody ?? "", frontmatter);
    try {
      await fs.writeFile(existing.path, content, "utf8");
    } catch (err) {
      const message = err instanceof Error ? err.message : "Cannot write SKILL.md";
      return NextResponse.json({ error: message }, { status: 500 });
    }
  }

  const updated = await prisma.skill.update({
    where: { id: skillId },
    data: {
      description: newDescription,
      body: newBody,
    },
  });
  return NextResponse.json(updated);
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ skillId: string }> },
) {
  const { skillId } = await params;
  const existing = await prisma.skill.findUnique({ where: { id: skillId } });
  if (!existing) {
    return NextResponse.json({ error: "Skill not found" }, { status: 404 });
  }
  if (existing.isBuiltIn) {
    return NextResponse.json(
      { error: "Built-in skills cannot be deleted" },
      { status: 403 },
    );
  }
  // Try removing SKILL.md if present (best-effort).
  if (existing.path) {
    try {
      await fs.rm(existing.path, { force: true });
    } catch {
      // ignore
    }
  }
  await prisma.skill.delete({ where: { id: skillId } });
  return NextResponse.json({ ok: true });
}
