// Skill recommender (server-side).
//
// Builds a compact project profile — definition document excerpts, each
// repo's package.json dependencies, stack services — and asks the LLM to
// rank the best-fitting skills from two pools: the workspace's installed
// catalog (attachable now) and skills.sh search results (installable).

import fs from "node:fs/promises";
import path from "node:path";
import { prisma } from "@nexux/db";

import { createAgentClient } from "./agents-generator";
import { searchRegistry } from "@/lib/skills-registry";
import { searchRegistryAgents } from "@/lib/agents-registry";
import { workspaceIdOfProject } from "@/lib/workspace";
import {
  buildProfile,
  buildRecommenderMessage,
  catalogCandidates as toCatalogCandidates,
  depsFromPackageJson,
  keywordsForDeps,
  parseRecommendations,
  renderDefinition,
  type Candidate,
  type SkillRecommendation,
} from "./recommender-core";

const INSTRUCTIONS = `You are the Skill Recommender for Nexus. A project's coding agent gets a set of SKILLS (guideline documents) injected into every run — good skills match the project's actual stack and goals; irrelevant ones waste context.

You receive a PROJECT PROFILE (definition excerpts, dependencies per repository, infra services) and two candidate pools:
- CATALOG: skills already installed in this workspace (attach instantly).
- REGISTRY: results from skills.sh (must be installed first).

Pick the 4-6 skills that would most improve the agent's output for THIS project. Prefer specific matches (framework, language, infra actually present) over generic ones. Do not recommend near-duplicates of each other, and never recommend something already attached (marked [attached]).

Reply with ONLY this JSON block, no prose:
\`\`\`json
{"recommendations": [{"source": "catalog" | "registry", "id": "<catalog skill id or registry id>", "name": "...", "reason": "one concrete sentence citing evidence from the profile"}]}
\`\`\``;

// Profile building, candidate formatting and answer parsing live in
// ./recommender-core (pure, unit-tested); re-exported so importers of this
// module keep seeing the type here.
export type { SkillRecommendation } from "./recommender-core";

async function readDeps(localPath: string): Promise<string[]> {
  try {
    const raw = await fs.readFile(path.join(localPath, "package.json"), "utf8");
    return depsFromPackageJson(raw);
  } catch {
    return [];
  }
}

export async function recommendSkills(projectId: string): Promise<{
  recommendations: SkillRecommendation[];
}> {
  const workspaceId = await workspaceIdOfProject(projectId);

  const [project, document, attached, catalog] = await Promise.all([
    prisma.project.findUnique({
      where: { id: projectId },
      include: {
        repositories: true,
        stackNodes: { where: { kind: "service" }, select: { name: true } },
      },
    }),
    prisma.projectDocument.findUnique({
      where: { projectId },
      include: { sections: { orderBy: { order: "asc" }, take: 8 } },
    }),
    prisma.projectSkill.findMany({
      where: { projectId },
      select: { skillId: true },
    }),
    prisma.skill.findMany({
      where: { workspaceId: { in: [workspaceId, "ws-default"] } },
    }),
  ]);
  if (!project) throw new Error("Project not found");
  const attachedIds = new Set(attached.map((a) => a.skillId));

  // --- profile ---
  const depsByRepo: string[] = [];
  const allDeps = new Set<string>();
  for (const repo of project.repositories) {
    if (!repo.localPath) continue;
    const deps = await readDeps(repo.localPath);
    deps.forEach((d) => allDeps.add(d));
    if (deps.length) depsByRepo.push(`- ${repo.name}: ${deps.join(", ")}`);
  }
  const profile = buildProfile(
    project,
    renderDefinition(document?.sections ?? []),
    depsByRepo,
  );

  // --- candidates ---
  const catalogCandidates = toCatalogCandidates(catalog, attachedIds);

  const keywords = keywordsForDeps(allDeps);
  const registrySeen = new Set<string>();
  const registryCandidates: Candidate[] = [];
  for (const kw of keywords.length ? keywords : ["best practices"]) {
    const hits = await searchRegistry(kw).catch(() => []);
    for (const h of hits.slice(0, 8)) {
      if (registrySeen.has(h.name)) continue;
      if (catalog.some((c) => c.name === h.name)) continue;
      registrySeen.add(h.name);
      registryCandidates.push({
        source: "registry",
        id: h.id,
        name: h.name,
        description: `${h.source} · ${h.installs.toLocaleString()} installs`,
      });
    }
  }

  const message = buildRecommenderMessage(
    profile,
    catalogCandidates,
    registryCandidates,
  );

  const { client, apiKey, modelProvider, modelName } = await createAgentClient(workspaceId);
  const agent = client.defineAgent({
    name: "skill-recommender",
    instructions: INSTRUCTIONS,
    modelProvider,
    modelName,
    apiKey,
    maxToolIterations: 1,
  });
  const result = await agent.run(message, { history: [] });
  return { recommendations: parseRecommendations(result.message ?? "", 6) };
}

const AGENT_INSTRUCTIONS = `You are the Agent Recommender for Nexus. Projects wire AGENTS (specialist personas with system prompts) into their orchestration; the right specialists for the project's stack and goals produce better plans and reviews.

You receive a PROJECT PROFILE and two candidate pools:
- CATALOG: agents already in this workspace (attach instantly).
- REGISTRY: agents from aitmpl.com (must be installed first).

Pick the 3-5 agents that best complement THIS project. Prefer stack-specific specialists (framework, language, infra actually present) plus at most one cross-cutting role (review/testing/security) if the profile justifies it. Skip near-duplicates and anything marked [attached].

Reply with ONLY this JSON block, no prose:
\`\`\`json
{"recommendations": [{"source": "catalog" | "registry", "id": "<catalog agent id or registry path>", "name": "...", "reason": "one concrete sentence citing evidence from the profile"}]}
\`\`\``;

/** Same profile, agent pools: workspace catalog + aitmpl registry. */
export async function recommendAgents(projectId: string): Promise<{
  recommendations: SkillRecommendation[];
}> {
  const workspaceId = await workspaceIdOfProject(projectId);

  const [project, document, attached, catalog] = await Promise.all([
    prisma.project.findUnique({
      where: { id: projectId },
      include: {
        repositories: true,
        stackNodes: { where: { kind: "service" }, select: { name: true } },
      },
    }),
    prisma.projectDocument.findUnique({
      where: { projectId },
      include: { sections: { orderBy: { order: "asc" }, take: 8 } },
    }),
    prisma.projectAgent.findMany({
      where: { projectId },
      select: { agentId: true },
    }),
    prisma.agent.findMany({
      where: { workspaceId: { in: [workspaceId, "ws-default"] } },
    }),
  ]);
  if (!project) throw new Error("Project not found");
  const attachedIds = new Set(attached.map((a) => a.agentId));

  const depsByRepo: string[] = [];
  const allDeps = new Set<string>();
  for (const repo of project.repositories) {
    if (!repo.localPath) continue;
    const deps = await readDeps(repo.localPath);
    deps.forEach((d) => allDeps.add(d));
    if (deps.length) depsByRepo.push(`- ${repo.name}: ${deps.join(", ")}`);
  }
  const profile = buildProfile(
    project,
    renderDefinition(document?.sections ?? []),
    depsByRepo,
  );

  const catalogCandidates = toCatalogCandidates(catalog, attachedIds);

  const registryAgents = await searchRegistryAgents("").catch(() => []);
  const registryCandidates: Candidate[] = registryAgents
    .filter((a) => !catalog.some((c) => c.name === a.name))
    .slice(0, 30)
    .map((a) => ({
      source: "registry",
      id: a.path,
      name: a.name,
      description: `${a.category} · ${a.downloads.toLocaleString()} downloads — ${a.description.slice(0, 120)}`,
    }));

  const message = buildRecommenderMessage(
    profile,
    catalogCandidates,
    registryCandidates,
  );

  const { client, apiKey, modelProvider, modelName } = await createAgentClient(workspaceId);
  const agent = client.defineAgent({
    name: "agent-recommender",
    instructions: AGENT_INSTRUCTIONS,
    modelProvider,
    modelName,
    apiKey,
    maxToolIterations: 1,
  });
  const result = await agent.run(message, { history: [] });
  return { recommendations: parseRecommendations(result.message ?? "", 5) };
}
