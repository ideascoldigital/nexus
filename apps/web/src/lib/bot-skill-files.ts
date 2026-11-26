// A bot's loaded skills as files for its computer (spec 38). A skill on disk
// (synced from ~/.claude/skills, or installed from skills.sh) goes with its
// whole folder — scripts and references included — and one that lives only
// in the database becomes a SKILL.md made from its name, description and body.

import fs from "node:fs/promises";
import path from "node:path";
import type { BotSkillFiles } from "@nexux/sandbox";

/** Enough for SKILL.md and its references; a folder past this is cut, not refused. */
const MAX_FILES = 200;
const MAX_BYTES = 5 * 1024 * 1024;
const SKIP = new Set([".git", "node_modules", ".DS_Store"]);

type SkillRow = { name: string; description: string | null; path: string | null; body: string | null };

/** SKILL.md for a skill with no folder: frontmatter Claude Code reads, then the body. */
export function renderSkillMd(skill: { name: string; description: string | null; body: string | null }): string {
  const desc = (skill.description ?? "").replace(/\s+/g, " ").trim() || `The ${skill.name} skill.`;
  return `---\nname: ${skill.name}\ndescription: ${JSON.stringify(desc)}\n---\n\n${(skill.body ?? "").trim()}\n`;
}

async function folderFiles(root: string): Promise<{ path: string; content: Buffer }[]> {
  const out: { path: string; content: Buffer }[] = [];
  let bytes = 0;
  const walk = async (dir: string): Promise<void> => {
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      if (out.length >= MAX_FILES || SKIP.has(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) await walk(full);
      else if (e.isFile()) {
        const content = await fs.readFile(full).catch(() => null);
        if (!content || bytes + content.length > MAX_BYTES) continue;
        bytes += content.length;
        out.push({ path: path.relative(root, full).split(path.sep).join("/"), content });
      }
    }
  };
  await walk(root);
  return out;
}

/** One skill's files: its folder when SKILL.md is on disk, else one made up. */
export async function skillFiles(skill: SkillRow): Promise<BotSkillFiles> {
  if (skill.path && path.basename(skill.path) === "SKILL.md") {
    const files = await folderFiles(path.dirname(skill.path));
    if (files.some((f) => f.path === "SKILL.md")) return { name: skill.name, files };
  }
  return { name: skill.name, files: [{ path: "SKILL.md", content: renderSkillMd(skill) }] };
}
