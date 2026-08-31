// skills.sh registry integration (server-side).
//
// skills.sh exposes fuzzy search at /api/search?q=…, returning entries whose
// id is "<owner>/<repo>/<skillName>" where skillName is the SKILL.md
// frontmatter `name` — NOT necessarily the directory name. Resolution walks
// the GitHub tree for SKILL.md files and matches frontmatter names, using the
// active git credential when available (unauthenticated works, rate-limited).

import matter from "gray-matter";
import { resolveGitCredential } from "@/lib/sandbox-manager";

const REGISTRY = "https://skills.sh";

export type RegistrySkill = {
  id: string;
  skillId: string;
  name: string;
  installs: number;
  source: string;
};

export type ResolvedSkill = {
  id: string;
  name: string;
  description: string;
  content: string;
  body: string;
  path: string;
  repoUrl: string;
};

export async function searchRegistry(query: string): Promise<RegistrySkill[]> {
  const res = await fetch(
    `${REGISTRY}/api/search?q=${encodeURIComponent(query)}`,
    { headers: { accept: "application/json" }, cache: "no-store" },
  );
  if (!res.ok) throw new Error(`skills.sh search failed (${res.status})`);
  const data = (await res.json()) as { skills?: RegistrySkill[] };
  return data.skills ?? [];
}

async function githubHeaders(): Promise<Record<string, string>> {
  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    "user-agent": "nexux",
  };
  // Credentials are global — any saved github token authenticates the fetch.
  const cred = await resolveGitCredential(null).catch(() => null);
  if (cred?.provider === "github") {
    headers.authorization = `Bearer ${cred.token}`;
  }
  return headers;
}

/** Find and fetch the SKILL.md behind a registry id ("owner/repo/skillName"). */
export async function resolveRegistrySkill(id: string): Promise<ResolvedSkill> {
  const parts = id.split("/");
  if (parts.length < 3) throw new Error("Invalid skill id");
  const [owner, repo] = parts;
  const skillName = parts.slice(2).join("/");

  const headers = await githubHeaders();
  const treeRes = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/git/trees/HEAD?recursive=1`,
    { headers, cache: "no-store" },
  );
  if (!treeRes.ok) {
    throw new Error(`Could not read ${owner}/${repo} (${treeRes.status})`);
  }
  const tree = (await treeRes.json()) as {
    tree?: Array<{ path: string; type: string }>;
  };
  const candidates = (tree.tree ?? [])
    .filter((t) => t.type === "blob" && t.path.endsWith("SKILL.md"))
    .map((t) => t.path);
  if (candidates.length === 0) {
    throw new Error("No SKILL.md files found in the repository");
  }

  // Likeliest first: directory named exactly like the skill, then dirs the
  // registry name ends with (repos often prefix names, e.g. vercel-*).
  const dirOf = (p: string) =>
    p.split("/").slice(-2, -1)[0]?.toLowerCase() ?? "";
  const ranked = [...candidates].sort((a, b) => {
    const score = (p: string) => {
      const dir = dirOf(p);
      if (dir === skillName.toLowerCase()) return 0;
      if (skillName.toLowerCase().endsWith(dir)) return 1;
      return 2;
    };
    return score(a) - score(b);
  });

  const rawHeaders = { ...headers, accept: "application/vnd.github.raw" };
  for (const path of ranked.slice(0, 15)) {
    const fileRes = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}`,
      { headers: rawHeaders, cache: "no-store" },
    );
    if (!fileRes.ok) continue;
    const content = await fileRes.text();
    try {
      const parsed = matter(content);
      const name = String(parsed.data?.name ?? "").trim();
      if (name.toLowerCase() === skillName.toLowerCase()) {
        return {
          id,
          name,
          description: String(parsed.data?.description ?? "").trim(),
          content,
          body: parsed.content.trim(),
          path,
          repoUrl: `https://github.com/${owner}/${repo}/blob/HEAD/${path}`,
        };
      }
    } catch {
      // unparseable frontmatter — skip
    }
  }
  throw new Error(
    `Could not locate "${skillName}" inside ${owner}/${repo} — the repo layout may be unsupported`,
  );
}
