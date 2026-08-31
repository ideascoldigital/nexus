import { prisma } from "@nexux/db";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import fs from "node:fs/promises";
import path from "node:path";
import matter from "gray-matter";
import { homeDir } from "@nexux/config";
import { getActiveWorkspaceId } from "@/lib/workspace";

const createSkillSchema = z.object({
  name: z.string().min(1).regex(/^[a-z0-9][a-z0-9-]*$/, {
    message: "Name must be lowercase letters, digits, and hyphens",
  }),
  description: z.string().optional(),
  source: z.string().default("custom"),
  scope: z.enum(["user", "project"]).default("user"),
  body: z.string().optional(),
});

export async function GET() {
  const workspaceId = await getActiveWorkspaceId();
  // Own catalog + inherited default-workspace items (disk-synced skills are
  // machine-global by nature) — own entries win on a name clash.
  const rows = await prisma.skill.findMany({
    where: { workspaceId: { in: [workspaceId, "ws-default"] } },
    include: {
      _count: {
        select: { projectSkills: true },
      },
    },
    orderBy: [{ source: "asc" }, { name: "asc" }],
  });
  const byName = new Map<string, (typeof rows)[number]>();
  for (const row of rows) {
    const existing = byName.get(row.name);
    if (!existing || row.workspaceId === workspaceId) byName.set(row.name, row);
  }
  return NextResponse.json(
    [...byName.values()].map((row) => ({
      ...row,
      inherited: row.workspaceId !== workspaceId,
    })),
  );
}

export async function POST(req: NextRequest) {
  const body = await req.json();
  const parsed = createSkillSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { message: "Invalid skill data", error: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const existing = await prisma.skill.findUnique({
    where: { name: parsed.data.name },
  });
  if (existing) {
    return NextResponse.json(
      { message: "Skill with this name already exists" },
      { status: 409 }
    );
  }

  const baseDir =
    parsed.data.scope === "project"
      ? path.join(process.cwd(), ".claude", "skills")
      : path.join(homeDir(), ".claude", "skills");

  const skillDir = path.join(baseDir, parsed.data.name);
  const skillFile = path.join(skillDir, "SKILL.md");

  await fs.mkdir(skillDir, { recursive: true });

  const frontmatter = {
    name: parsed.data.name,
    description: parsed.data.description ?? "",
  };
  const fileContent = matter.stringify(parsed.data.body ?? "", frontmatter);
  await fs.writeFile(skillFile, fileContent, "utf8");

  const skill = await prisma.skill.create({
    data: {
      name: parsed.data.name,
      description: parsed.data.description,
      workspaceId: await getActiveWorkspaceId(),
      source: "custom",
      scope: parsed.data.scope,
      path: skillFile,
      body: parsed.data.body,
    },
  });
  return NextResponse.json(skill, { status: 201 });
}
