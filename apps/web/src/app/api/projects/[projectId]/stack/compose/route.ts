import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { buildProjectCompose, writeComposeFile } from "@/lib/stack/compose-io";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ projectId: string }> };

const bodySchema = z.object({ dryRun: z.boolean().optional() });

export async function POST(req: NextRequest, { params }: Params) {
  const { projectId } = await params;
  const parsed = bodySchema.safeParse(await req.json().catch(() => ({})));

  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const compose = await buildProjectCompose(projectId);
  if (!compose) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  if (parsed.data.dryRun) {
    return NextResponse.json({
      path: null,
      yaml: compose.yaml,
      warnings: compose.warnings,
    });
  }

  if (compose.yaml && !compose.composeDir) {
    return NextResponse.json(
      {
        error:
          "Project has no workspacePath and no main repository with a local path — nowhere to write the compose file.",
      },
      { status: 400 }
    );
  }

  const filePath = await writeComposeFile(compose);
  return NextResponse.json({
    path: filePath,
    yaml: compose.yaml,
    warnings: compose.warnings,
  });
}
