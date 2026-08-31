import { prisma } from "@nexux/db";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import fs from "node:fs/promises";
import path from "node:path";
import { homeDir } from "@nexux/config";
import { resolveRegistryAgent } from "@/lib/agents-registry";
import { getActiveWorkspaceId } from "@/lib/workspace";

export const dynamic = "force-dynamic";

const schema = z.object({ path: z.string().min(1) });

/**
 * Install an aitmpl.com agent: write the .md to ~/.claude/agents/<name>.md
 * (where Claude Code discovers user agents) and register it in the active
 * workspace's catalog.
 */
export async function POST(req: NextRequest) {
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "path is required" }, { status: 400 });
  }

  const workspaceId = await getActiveWorkspaceId();

  let resolved;
  try {
    resolved = await resolveRegistryAgent(parsed.data.path);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Resolve failed";
    return NextResponse.json({ error: message }, { status: 502 });
  }

  const existing = await prisma.agent.findUnique({
    where: { name: resolved.name },
  });
  if (existing) {
    return NextResponse.json(
      {
        error:
          existing.workspaceId === workspaceId
            ? "Agent already installed in this workspace"
            : "An agent with this name exists in another workspace",
      },
      { status: 409 },
    );
  }

  const agentsDir = path.join(homeDir(), ".claude", "agents");
  await fs.mkdir(agentsDir, { recursive: true });
  const agentFile = path.join(agentsDir, `${resolved.name}.md`);
  await fs.writeFile(agentFile, resolved.content, "utf8");

  const agent = await prisma.agent.create({
    data: {
      name: resolved.name,
      description: resolved.description || null,
      systemPrompt: resolved.systemPrompt,
      model: resolved.model ?? "opus",
      workspaceId,
      filePath: agentFile,
    },
  });

  return NextResponse.json(agent, { status: 201 });
}
