// Pure parts of the skill/agent recommenders: turning a project into a
// profile string, picking registry search keywords, formatting candidate
// pools, and reading the model's answer back. No prisma, no filesystem, no
// agent client — recommendSkills/recommendAgents supply those.

export type Candidate = {
  source: "catalog" | "registry";
  id: string;
  name: string;
  description: string;
};

export type SkillRecommendation = {
  source: "catalog" | "registry";
  id: string;
  name: string;
  reason: string;
};

/** The project fields a profile is built from. */
export type ProfileInput = {
  name: string;
  description?: string | null;
  stackNodes: { name: string }[];
};

export type ProfileSection = { title: string; content?: string | null };

const SECTION_CHARS = 220;
const DEFINITION_CHARS = 1800;
const DESCRIPTION_CHARS = 160;

/** Frameworks worth searching the registry for — dependency name → query. */
export const KEYWORD_DEPS = [
  "next", "react", "vue", "nuxt", "svelte", "angular", "express", "fastify",
  "nest", "prisma", "drizzle", "tailwindcss", "typescript", "playwright",
  "vitest", "jest", "graphql", "stripe", "supabase", "firebase",
];

/** Dependency names extracted from a package.json, capped for prompt size. */
export function depsFromPackageJson(raw: string): string[] {
  try {
    const pkg = JSON.parse(raw) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    return [
      ...Object.keys(pkg.dependencies ?? {}),
      ...Object.keys(pkg.devDependencies ?? {}),
    ].slice(0, 40);
  } catch {
    return [];
  }
}

/** Definition excerpts, whitespace-collapsed and clipped for the prompt. */
export function renderDefinition(sections: ProfileSection[]): string {
  return sections
    .map(
      (s) =>
        `${s.title}: ${(s.content ?? "").replace(/\s+/g, " ").slice(0, SECTION_CHARS)}`
    )
    .join("\n")
    .slice(0, DEFINITION_CHARS);
}

/**
 * The profile the model reasons over. Sections with nothing to say are left
 * out entirely rather than emitted empty.
 */
export function buildProfile(
  project: ProfileInput,
  definition: string,
  depsByRepo: string[]
): string {
  return [
    `Project: ${project.name}`,
    project.description ? `Description: ${project.description}` : "",
    definition ? `Definition:\n${definition}` : "",
    depsByRepo.length ? `Dependencies:\n${depsByRepo.join("\n")}` : "",
    project.stackNodes.length
      ? `Infra services: ${project.stackNodes.map((s) => s.name).join(", ")}`
      : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** Up to three registry queries implied by the project's dependencies. */
export function keywordsForDeps(deps: Iterable<string>): string[] {
  const all = [...deps];
  return KEYWORD_DEPS.filter((k) =>
    all.some((d) => d === k || d.startsWith(`${k}-`) || d.includes(k))
  ).slice(0, 3);
}

/** Catalog entries, marking the ones already attached to this project. */
export function catalogCandidates(
  entries: { id: string; name: string; description?: string | null }[],
  attachedIds: Set<string>
): Candidate[] {
  return entries.map((e) => ({
    source: "catalog",
    id: e.id,
    name: e.name + (attachedIds.has(e.id) ? " [attached]" : ""),
    description: (e.description ?? "").slice(0, DESCRIPTION_CHARS),
  }));
}

export function formatCandidate(c: Candidate): string {
  return `- [${c.source}] id=${c.id} ${c.name}${c.description ? ` — ${c.description}` : ""}`;
}

/** The single prompt: profile plus both candidate pools. */
export function buildRecommenderMessage(
  profile: string,
  catalog: Candidate[],
  registry: Candidate[]
): string {
  return `PROJECT PROFILE:\n${profile}\n\nCATALOG:\n${
    catalog.map(formatCandidate).join("\n") || "(empty)"
  }\n\nREGISTRY:\n${registry.map(formatCandidate).join("\n") || "(empty)"}`;
}

/**
 * Read the model's answer. Throws when it cannot be parsed at all — the
 * caller surfaces that as "retry" rather than silently recommending nothing.
 */
export function parseRecommendations(
  raw: string,
  limit: number
): SkillRecommendation[] {
  const block = raw.match(/```json\s*([\s\S]*?)```/)?.[1] ?? raw;
  let parsed: { recommendations?: SkillRecommendation[] };
  try {
    parsed = JSON.parse(block) as { recommendations?: SkillRecommendation[] };
  } catch {
    throw new Error("The recommender returned an unparseable answer — retry");
  }
  return (parsed.recommendations ?? [])
    .filter(
      (r) =>
        (r.source === "catalog" || r.source === "registry") &&
        typeof r.id === "string" &&
        typeof r.name === "string"
    )
    .map((r) => ({ ...r, name: r.name.replace(" [attached]", "") }))
    .slice(0, limit);
}
