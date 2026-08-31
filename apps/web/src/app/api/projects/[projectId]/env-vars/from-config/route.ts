import { prisma } from "@nexux/db";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { listEnvPresets, resolveEnvPresets } from "@/lib/env-presets";
import { workspaceIdOfProject } from "@/lib/workspace";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ projectId: string }> };

/**
 * List the saved credentials / global Settings that can be copied into this
 * project's env vars. Values are masked — the plaintext is resolved server-side
 * on POST, so the browser only ever handles opaque preset ids.
 */
export async function GET(_req: NextRequest, { params }: Params) {
  const { projectId } = await params;
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { workspaceId: true },
  });
  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }
  return NextResponse.json({
    presets: await listEnvPresets(project.workspaceId),
  });
}

const fromConfigSchema = z.object({
  /** Opaque ids from GET: "credential:<id>" | "setting:<settings key>". */
  presetIds: z.array(z.string().min(1)).min(1).max(50),
  repositoryId: z.string().optional().nullable(),
  overwrite: z.boolean().default(true),
});

/**
 * Copy secrets from the saved configs (LLM/git/Claude credentials, global
 * Settings) into the project's env vars.
 *
 * A copy, not a live reference — same rule as from-stack. Two consequences the
 * UI has to surface: rotating the credential later does not update this copy,
 * and the copy now outranks the original at launch (project env vars win), so
 * the global panel will start reporting the source as overridden.
 */
export async function POST(req: NextRequest, { params }: Params) {
  const { projectId } = await params;
  const parsed = fromConfigSchema.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const { presetIds, overwrite } = parsed.data;
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

  const workspaceId = await workspaceIdOfProject(projectId);
  const { entries, missing } = await resolveEnvPresets(workspaceId, presetIds);

  if (entries.length === 0) {
    return NextResponse.json(
      { error: "None of the selected configs still hold a value", missing },
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

  // Sequential, matching the other import routes: SQLite serialises writes, and
  // a partial import stays useful if one row trips a constraint.
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

  return NextResponse.json({ created, updated, skipped, missing });
}
