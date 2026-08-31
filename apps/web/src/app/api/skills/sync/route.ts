import { prisma } from "@nexux/db";
import { NextResponse } from "next/server";
import fs from "node:fs/promises";
import path from "node:path";
import matter from "gray-matter";
import { homeDir } from "@nexux/config";

type Discovered = {
  name: string;
  description: string;
  source: string; // user | plugin | project
  scope: string;
  path: string;
  body: string;
};

async function readSkillFile(filePath: string): Promise<{
  name?: string;
  description?: string;
  body: string;
} | null> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = matter(raw);
    const data = parsed.data as Record<string, unknown>;
    return {
      name: typeof data.name === "string" ? data.name : undefined,
      description:
        typeof data.description === "string" ? data.description : undefined,
      body: parsed.content,
    };
  } catch {
    return null;
  }
}

async function dirExists(p: string): Promise<boolean> {
  try {
    const stat = await fs.stat(p);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

async function scanSkillsDir(
  rootDir: string,
  source: string,
  scope: string
): Promise<Discovered[]> {
  if (!(await dirExists(rootDir))) return [];
  const entries = await fs.readdir(rootDir, { withFileTypes: true });
  const found: Discovered[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skillDir = path.join(rootDir, entry.name);
    const skillFile = path.join(skillDir, "SKILL.md");
    const parsed = await readSkillFile(skillFile);
    if (!parsed) continue;
    const name = parsed.name || entry.name;
    found.push({
      name,
      description: parsed.description ?? "",
      source,
      scope,
      path: skillFile,
      body: parsed.body,
    });
  }
  return found;
}

async function scanPluginsCache(rootDir: string): Promise<Discovered[]> {
  if (!(await dirExists(rootDir))) return [];
  const found: Discovered[] = [];
  const plugins = await fs.readdir(rootDir, { withFileTypes: true });

  for (const plugin of plugins) {
    if (!plugin.isDirectory()) continue;
    const pluginRoot = path.join(rootDir, plugin.name);
    // pattern: cache/<plugin>/<inner>/skills/<skill>/SKILL.md
    const inner = await fs.readdir(pluginRoot, { withFileTypes: true });
    for (const sub of inner) {
      if (!sub.isDirectory()) continue;
      const skillsDir = path.join(pluginRoot, sub.name, "skills");
      const items = await scanSkillsDir(skillsDir, "plugin", "plugin");
      found.push(...items);
      // also try cache/<plugin>/skills directly
    }
    const directSkills = path.join(pluginRoot, "skills");
    const direct = await scanSkillsDir(directSkills, "plugin", "plugin");
    found.push(...direct);
  }
  return found;
}

export async function POST() {
  const home = homeDir();
  const cwd = process.cwd();

  const userSkills = await scanSkillsDir(
    path.join(home, ".claude", "skills"),
    "user",
    "user"
  );
  const projectSkills = await scanSkillsDir(
    path.join(cwd, ".claude", "skills"),
    "project",
    "project"
  );
  const pluginSkills = await scanPluginsCache(
    path.join(home, ".claude", "plugins", "cache")
  );

  const all = [...userSkills, ...projectSkills, ...pluginSkills];
  const seen = new Set<string>();
  const unique: Discovered[] = [];
  for (const skill of all) {
    if (seen.has(skill.name)) continue;
    seen.add(skill.name);
    unique.push(skill);
  }

  let synced = 0;
  for (const skill of unique) {
    await prisma.skill.upsert({
      where: { name: skill.name },
      create: {
        name: skill.name,
        description: skill.description,
        source: skill.source,
        scope: skill.scope,
        path: skill.path,
        body: skill.body,
        isBuiltIn: false,
      },
      update: {
        description: skill.description,
        source: skill.source,
        scope: skill.scope,
        path: skill.path,
        body: skill.body,
      },
    });
    synced++;
  }

  return NextResponse.json({ synced, total: unique.length });
}
