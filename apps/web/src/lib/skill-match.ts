// Finding a registry skill's SKILL.md in its repo (skills-registry.ts): the
// registry names it by its frontmatter `name`, which need not be its folder's.
// Pure, so it is testable without the network.

import matter from "gray-matter";

/** Likeliest first: a folder named like the skill, then one the name ends with (repos prefix names). */
export function rankSkillPaths(paths: string[], skillName: string): string[] {
  const want = skillName.toLowerCase();
  const dirOf = (p: string) => p.split("/").slice(-2, -1)[0]?.toLowerCase() ?? "";
  const score = (p: string) => {
    const dir = dirOf(p);
    if (dir === want) return 0;
    if (dir && want.endsWith(dir)) return 1;
    return 2;
  };
  return [...paths].sort((a, b) => score(a) - score(b));
}

/** The SKILL.md whose frontmatter name is the skill's, or null. */
export function matchSkillMd(content: string, skillName: string): { name: string; description: string; body: string } | null {
  try {
    const parsed = matter(content);
    const name = String(parsed.data?.name ?? "").trim();
    if (name.toLowerCase() !== skillName.toLowerCase()) return null;
    return { name, description: String(parsed.data?.description ?? "").trim(), body: parsed.content.trim() };
  } catch {
    return null; // unparseable frontmatter
  }
}
