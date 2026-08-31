// aitmpl.com (Claude Code Templates) agent registry integration.
//
// The registry publishes a components.json (~2MB) on GitHub Pages with 400+
// agent definitions; each agent's .md lives in the davila7/claude-code-
// templates repo under cli-tool/components/agents/<path>. Frontmatter maps
// 1:1 onto Nexus's Agent model (name/description/model + body as the system
// prompt).

import matter from "gray-matter";

const COMPONENTS_URL =
  "https://davila7.github.io/claude-code-templates/components.json";
const RAW_BASE =
  "https://raw.githubusercontent.com/davila7/claude-code-templates/main/cli-tool/components/agents";

export type RegistryAgent = {
  name: string;
  path: string;
  category: string;
  description: string;
  downloads: number;
};

export type ResolvedAgent = {
  name: string;
  description: string;
  model: string | null;
  tools: string | null;
  systemPrompt: string;
  content: string;
  path: string;
  repoUrl: string;
};

// The catalog is 2MB — cache it; it only changes when the repo publishes.
let cache: { at: number; agents: RegistryAgent[] } | null = null;
const CACHE_MS = 10 * 60 * 1000;

export async function listRegistryAgents(): Promise<RegistryAgent[]> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.agents;
  const res = await fetch(COMPONENTS_URL, { cache: "no-store" });
  if (!res.ok) throw new Error(`aitmpl registry failed (${res.status})`);
  const data = (await res.json()) as {
    agents?: Array<{
      name: string;
      path: string;
      category?: string;
      description?: string;
      downloads?: number;
    }>;
  };
  const agents = (data.agents ?? []).map((a) => ({
    name: a.name,
    path: a.path,
    category: a.category ?? "general",
    description: (a.description ?? "").replace(/^"|"$/g, ""),
    downloads: a.downloads ?? 0,
  }));
  cache = { at: Date.now(), agents };
  return agents;
}

export async function searchRegistryAgents(
  query: string,
): Promise<RegistryAgent[]> {
  const agents = await listRegistryAgents();
  const q = query.trim().toLowerCase();
  const pool = q
    ? agents.filter(
        (a) =>
          a.name.toLowerCase().includes(q) ||
          a.category.toLowerCase().includes(q) ||
          a.description.toLowerCase().includes(q),
      )
    : agents;
  return [...pool].sort((a, b) => b.downloads - a.downloads).slice(0, 30);
}

export async function resolveRegistryAgent(
  path: string,
): Promise<ResolvedAgent> {
  // paths come from the catalog itself, but never let one escape the repo dir
  if (path.includes("..") || !path.endsWith(".md")) {
    throw new Error("Invalid agent path");
  }
  const res = await fetch(`${RAW_BASE}/${path}`, { cache: "no-store" });
  if (!res.ok) throw new Error(`Could not fetch the agent (${res.status})`);
  const content = await res.text();
  const parsed = matter(content);
  const name = String(parsed.data?.name ?? "").trim();
  if (!name) throw new Error("The agent file has no name in its frontmatter");
  return {
    name,
    description: String(parsed.data?.description ?? "").trim(),
    model: parsed.data?.model ? String(parsed.data.model) : null,
    tools: parsed.data?.tools ? String(parsed.data.tools) : null,
    systemPrompt: parsed.content.trim(),
    content,
    path,
    repoUrl: `https://github.com/davila7/claude-code-templates/blob/main/cli-tool/components/agents/${path}`,
  };
}
