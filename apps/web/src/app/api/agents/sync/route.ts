import { prisma } from "@nexux/db";
import { NextResponse } from "next/server";
import fs from "node:fs/promises";
import path from "node:path";
import matter from "gray-matter";
import { homeDir } from "@nexux/config";

type Discovered = {
  name: string;
  description: string | null;
  systemPrompt: string;
  model: string;
  color: string;
  filePath: string;
};

async function dirExists(p: string): Promise<boolean> {
  try {
    const stat = await fs.stat(p);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

async function readAgentFile(filePath: string): Promise<Discovered | null> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = matter(raw);
    const data = parsed.data as Record<string, unknown>;
    const name =
      (typeof data.name === "string" && data.name) ||
      path.basename(filePath, path.extname(filePath));
    return {
      name,
      description:
        typeof data.description === "string" ? data.description : null,
      systemPrompt: parsed.content.trim(),
      model: typeof data.model === "string" ? data.model : "opus",
      color: typeof data.color === "string" ? data.color : "#6366f1",
      filePath,
    };
  } catch {
    return null;
  }
}

async function scanAgentsDir(dir: string): Promise<Discovered[]> {
  if (!(await dirExists(dir))) return [];
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const found: Discovered[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith(".md")) continue;
    const agent = await readAgentFile(path.join(dir, entry.name));
    if (agent) found.push(agent);
  }
  return found;
}

async function scanPluginAgents(cacheRoot: string): Promise<Discovered[]> {
  if (!(await dirExists(cacheRoot))) return [];
  const found: Discovered[] = [];
  const plugins = await fs.readdir(cacheRoot, { withFileTypes: true });
  for (const plugin of plugins) {
    if (!plugin.isDirectory()) continue;
    const pluginRoot = path.join(cacheRoot, plugin.name);
    const inner = await fs.readdir(pluginRoot, { withFileTypes: true });
    for (const sub of inner) {
      if (!sub.isDirectory()) continue;
      const agentsDir = path.join(pluginRoot, sub.name, "agents");
      const items = await scanAgentsDir(agentsDir);
      found.push(...items);
    }
    const direct = await scanAgentsDir(path.join(pluginRoot, "agents"));
    found.push(...direct);
  }
  return found;
}

export async function POST() {
  try {
    const home = homeDir();
    const cwd = process.cwd();

    const userAgents = await scanAgentsDir(path.join(home, ".claude", "agents"));
    const projectAgents = await scanAgentsDir(
      path.join(cwd, ".claude", "agents")
    );
    const pluginAgents = await scanPluginAgents(
      path.join(home, ".claude", "plugins", "cache")
    );

    const all = [...userAgents, ...projectAgents, ...pluginAgents];
    const seen = new Set<string>();
    const unique: Discovered[] = [];
    for (const agent of all) {
      if (seen.has(agent.name)) continue;
      seen.add(agent.name);
      unique.push(agent);
    }

    let synced = 0;
    for (const agent of unique) {
      await prisma.agent.upsert({
        where: { name: agent.name },
        create: {
          name: agent.name,
          description: agent.description,
          systemPrompt: agent.systemPrompt,
          model: agent.model,
          color: agent.color,
          isBuiltIn: true,
          filePath: agent.filePath,
        },
        update: {
          description: agent.description,
          systemPrompt: agent.systemPrompt,
          model: agent.model,
          filePath: agent.filePath,
        },
      });
      synced++;
    }

    return NextResponse.json({ synced, total: unique.length });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to sync agents";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
