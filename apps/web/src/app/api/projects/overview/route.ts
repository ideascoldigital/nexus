import fs from "node:fs/promises";
import path from "node:path";
import { prisma } from "@nexux/db";
import { NextResponse } from "next/server";
import { getActiveWorkspaceId } from "@/lib/workspace";

// Framework/tooling names worth surfacing on a card, in display priority.
const KNOWN_TECHS = [
  "next", "nuxt", "react", "vue", "svelte", "astro", "angular", "express",
  "fastify", "nest", "prisma", "drizzle", "tailwindcss", "typescript",
];

/** Detect a repo's stack from its package.json dependencies (best-effort). */
async function detectTechs(localPath: string | null): Promise<string[]> {
  if (!localPath) return [];
  try {
    const raw = await fs.readFile(path.join(localPath, "package.json"), "utf8");
    const pkg = JSON.parse(raw) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const deps = new Set([
      ...Object.keys(pkg.dependencies ?? {}),
      ...Object.keys(pkg.devDependencies ?? {}),
    ]);
    return KNOWN_TECHS.filter((t) => deps.has(t)).slice(0, 3);
  } catch {
    return [];
  }
}

export const dynamic = "force-dynamic";

/**
 * Card data for the Projects page (design 8/9): per project — stack names,
 * live status (running task > active sandbox > idle), setup progress (same 5
 * steps as the dashboard checklist), latest open PR and running-task count.
 */
export async function GET() {
  const workspaceId = await getActiveWorkspaceId();

  const [
    projects,
    embeddingCounts,
    phaseCounts,
    wiringCounts,
    agentCounts,
    skillCounts,
    tokenRows,
    gitCredential,
    claudeCredential,
    recentPrTasks,
    runningTasks,
  ] = await Promise.all([
    prisma.project.findMany({
      where: { workspaceId },
      orderBy: { updatedAt: "desc" },
      include: {
        repositories: { select: { id: true, localPath: true, isMain: true } },
        stackNodes: { where: { kind: "service" }, select: { name: true } },
        sandboxes: {
          where: { status: { in: ["provisioning", "running"] }, archived: false },
          select: { id: true, status: true },
        },
        _count: { select: { features: true, stackNodes: true } },
      },
    }),
    prisma.embeddingIndex.groupBy({ by: ["projectId"], _count: true }),
    prisma.phase.groupBy({ by: ["projectId"], _count: true }),
    prisma.agentSkill.groupBy({
      by: ["projectId"],
      where: { NOT: { projectId: null } },
      _count: true,
    }),
    prisma.projectAgent.groupBy({ by: ["projectId"], _count: true }),
    prisma.projectSkill.groupBy({ by: ["projectId"], _count: true }),
    prisma.projectEnvVar.findMany({
      where: {
        repositoryId: null,
        key: {
          in: [
            "GITHUB_TOKEN",
            "GITLAB_TOKEN",
            "BITBUCKET_TOKEN",
            "CLAUDE_CODE_OAUTH_TOKEN",
          ],
        },
      },
      select: { projectId: true, key: true },
    }),
    // Credentials are global — not scoped to the active workspace.
    prisma.cloudCredential.findFirst({
      where: { provider: { in: ["github", "gitlab", "bitbucket"] } },
      select: { id: true },
    }),
    prisma.cloudCredential
      .findFirst({
        where: { provider: "claude" },
        select: { id: true },
      })
      .then(
        (cred) =>
          cred ??
          prisma.settings.findFirst({
            where: { isActive: true, key: "claude_code_oauth_token" },
            select: { id: true },
          }),
      ),
    prisma.sandboxTask.findMany({
      where: {
        NOT: { prUrl: null },
        sandbox: { project: { workspaceId } },
      },
      orderBy: { createdAt: "desc" },
      take: 30,
      select: {
        prUrl: true,
        sandbox: { select: { project: { select: { id: true } } } },
      },
    }),
    prisma.sandboxTask.findMany({
      where: {
        status: { in: ["running", "queued"] },
        sandbox: { project: { workspaceId } },
      },
      select: { sandbox: { select: { project: { select: { id: true } } } } },
    }),
  ]);

  const embeddingsByProject = new Map(
    embeddingCounts.map((e) => [e.projectId, e._count]),
  );
  const phasesByProject = new Set(phaseCounts.map((p) => p.projectId));
  // Wired = agent→skill edges OR the crew attached (agents AND skills) —
  // the recommender attaches without drawing edges.
  const edgeProjects = new Set(wiringCounts.map((w) => w.projectId));
  const agentProjects = new Set(agentCounts.map((a) => a.projectId));
  const skillProjects = new Set(skillCounts.map((sk) => sk.projectId));
  const wiredProjects = new Set([
    ...edgeProjects,
    ...[...agentProjects].filter((id) => skillProjects.has(id)),
  ]);
  const tokensByProject = new Map<string, Set<string>>();
  for (const t of tokenRows) {
    const set = tokensByProject.get(t.projectId) ?? new Set<string>();
    set.add(t.key);
    tokensByProject.set(t.projectId, set);
  }
  const tokensOk = (projectId: string) => {
    const keys = tokensByProject.get(projectId) ?? new Set<string>();
    const gitOk =
      Boolean(gitCredential) ||
      ["GITHUB_TOKEN", "GITLAB_TOKEN", "BITBUCKET_TOKEN"].some((k) =>
        keys.has(k),
      );
    const claudeOk =
      Boolean(claudeCredential) || keys.has("CLAUDE_CODE_OAUTH_TOKEN");
    return gitOk && claudeOk;
  };
  const lastPrByProject = new Map<string, string>();
  for (const t of recentPrTasks) {
    const pid = t.sandbox.project.id;
    if (!lastPrByProject.has(pid) && t.prUrl) lastPrByProject.set(pid, t.prUrl);
  }
  const runningByProject = new Map<string, number>();
  for (const t of runningTasks) {
    const pid = t.sandbox.project.id;
    runningByProject.set(pid, (runningByProject.get(pid) ?? 0) + 1);
  }

  return NextResponse.json(
    await Promise.all(
      projects.map(async (p) => {
      const mainRepo =
        p.repositories.find((r) => r.isMain) ?? p.repositories[0] ?? null;
      const techs =
        p.stackNodes.length > 0 ? [] : await detectTechs(mainRepo?.localPath ?? null);
      const steps = [
        p.repositories.length > 0,
        phasesByProject.has(p.id),
        p._count.stackNodes > 0,
        wiredProjects.has(p.id),
        tokensOk(p.id),
      ];
      return {
        id: p.id,
        name: p.name,
        description: p.description,
        updatedAt: p.updatedAt,
        repos: p.repositories.length,
        features: p._count.features,
        stackNames: p.stackNodes.map((s) => s.name),
        techs,
        embeddings: embeddingsByProject.get(p.id) ?? 0,
        sandboxUp: p.sandboxes.some((s) => s.status === "running"),
        runningTasks: runningByProject.get(p.id) ?? 0,
        lastPrUrl: lastPrByProject.get(p.id) ?? null,
        setupDone: steps.filter(Boolean).length,
        setupTotal: steps.length,
      };
      }),
    ),
  );
}
