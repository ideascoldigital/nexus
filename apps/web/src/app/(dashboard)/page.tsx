export const dynamic = "force-dynamic";

// Dashboard — global home (design 1a): projects with live state, activity
// feed, and active sandboxes. Server component: one round of prisma queries.

import { AppHeader } from "@/components/layout/app-header";
import { prisma } from "@nexux/db";
import {
  Activity,
  ArrowRight,
  CheckCircle2,
  CircleDot,
  FolderKanban,
  Loader2,
  Rocket,
  Terminal,
  XCircle,
} from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import Link from "next/link";
import { formatDistanceToNow } from "date-fns";
import { getActiveWorkspaceId } from "@/lib/workspace";
import { getWorkspaceMetrics } from "@/lib/metrics";
import { Sparkline } from "@/components/ui/sparkline";
import { StatTile } from "@/components/ui/stat-tile";

async function getDashboard() {
  const workspaceId = await getActiveWorkspaceId();
  const [projects, activeSandboxes, recentTasks, recentSandboxes] =
    await Promise.all([
      prisma.project.findMany({
        where: { workspaceId },
        orderBy: { updatedAt: "desc" },
        include: {
          repositories: { select: { id: true } },
          stackNodes: { where: { kind: "service" }, select: { id: true } },
          sandboxes: {
            where: { status: { in: ["provisioning", "running"] } },
            select: { id: true, status: true, name: true },
          },
          _count: { select: { features: true, stackNodes: true } },
        },
      }),
      prisma.sandbox.findMany({
        where: {
          status: { in: ["provisioning", "running"] },
          project: { workspaceId },
        },
        orderBy: { createdAt: "desc" },
        include: { project: { select: { id: true, name: true } } },
      }),
      prisma.sandboxTask.findMany({
        where: { sandbox: { project: { workspaceId } } },
        orderBy: { createdAt: "desc" },
        take: 8,
        include: {
          feature: { select: { title: true } },
          sandbox: {
            select: {
              name: true,
              project: { select: { id: true, name: true } },
            },
          },
        },
      }),
      prisma.sandbox.findMany({
        where: { archived: false, project: { workspaceId } },
        orderBy: { createdAt: "desc" },
        take: 5,
        include: { project: { select: { id: true, name: true } } },
      }),
    ]);

  const embeddingCounts = await prisma.embeddingIndex.groupBy({
    by: ["projectId"],
    _count: true,
  });
  const embeddingsByProject = new Map(
    embeddingCounts.map((e) => [e.projectId, e._count]),
  );

  // Setup progress (the 5 checklist steps) drives each card's bar.
  const [
    phaseCounts,
    wiringCounts,
    agentCounts,
    skillCounts,
    tokenRows,
    gitCredential,
    claudeSetting,
  ] =
    await Promise.all([
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
      prisma.cloudCredential.findFirst({
        where: { provider: { in: ["github", "gitlab", "bitbucket"] } },
        select: { id: true },
      }),
      // Saved claude credential, or the legacy Settings row.
      prisma.cloudCredential
        .findFirst({ where: { provider: "claude" }, select: { id: true } })
        .then(
          (cred) =>
            cred ??
            prisma.settings.findFirst({
              where: { isActive: true, key: "claude_code_oauth_token" },
              select: { id: true },
            }),
        ),
    ]);
  const phasesByProject = new Set(phaseCounts.map((p) => p.projectId));
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
  // Tokens step mirrors the launch gate: git token via saved credential or
  // project env var; Claude Code token via Settings or project env var.
  const projectTokensOk = (projectId: string) => {
    const keys = tokensByProject.get(projectId) ?? new Set<string>();
    const gitOk =
      Boolean(gitCredential) ||
      ["GITHUB_TOKEN", "GITLAB_TOKEN", "BITBUCKET_TOKEN"].some((k) =>
        keys.has(k),
      );
    const claudeOk =
      Boolean(claudeSetting) || keys.has("CLAUDE_CODE_OAUTH_TOKEN");
    return gitOk && claudeOk;
  };

  const runningTasks = recentTasks.filter((t) => t.status === "running");

  type ActivityItem = {
    id: string;
    kind: "task-done" | "task-error" | "task-running" | "sandbox";
    text: string;
    projectId: string;
    time: Date;
  };
  const activity: ActivityItem[] = [];
  for (const t of recentTasks) {
    const title = t.feature?.title ?? t.prompt.slice(0, 60);
    const project = t.sandbox.project;
    activity.push({
      id: `task-${t.id}`,
      kind:
        t.status === "completed"
          ? "task-done"
          : t.status === "error"
            ? "task-error"
            : "task-running",
      text: `${title} (${project.name})${t.prUrl ? " · PR opened" : ""}`,
      projectId: project.id,
      time: t.finishedAt ?? t.createdAt,
    });
  }
  for (const s of recentSandboxes) {
    activity.push({
      id: `sandbox-${s.id}`,
      kind: "sandbox",
      text: `Sandbox ${s.name} ${s.status} (${s.project.name})`,
      projectId: s.project.id,
      time: s.createdAt,
    });
  }
  activity.sort((a, b) => b.time.getTime() - a.time.getTime());

  return {
    projects: projects.map((p) => {
      const steps = [
        p.repositories.length > 0,
        phasesByProject.has(p.id),
        p._count.stackNodes > 0,
        wiredProjects.has(p.id),
        projectTokensOk(p.id),
      ];
      const setupDone = steps.filter(Boolean).length;
      return {
        id: p.id,
        name: p.name,
        description: p.description,
        repos: p.repositories.length,
        services: p.stackNodes.length,
        features: p._count.features,
        embeddings: embeddingsByProject.get(p.id) ?? 0,
        sandboxes: p.sandboxes,
        runningTask: runningTasks.some((t) => t.sandbox.project.id === p.id),
        setupDone,
        setupTotal: steps.length,
      };
    }),
    activeSandboxes,
    activity: activity.slice(0, 8),
    runningTaskCount: runningTasks.length,
  };
}

const ACTIVITY_ICON = {
  "task-done": { icon: CheckCircle2, className: "text-primary" },
  "task-error": { icon: XCircle, className: "text-destructive" },
  "task-running": { icon: Loader2, className: "text-amber-400" },
  sandbox: { icon: Rocket, className: "text-sky-400" },
} as const;

export default async function DashboardPage() {
  const [data, metrics] = await Promise.all([
    getDashboard(),
    getActiveWorkspaceId().then(getWorkspaceMetrics),
  ]);


  return (
    <>
      <AppHeader title="Dashboard" />
      <div className="flex flex-1 min-h-0">

        <div className="flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-6xl px-4 py-6 space-y-5">
          {/* Pulse: spend, runs, delivery, machines, review queue. */}
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
            <StatTile
              className="col-span-2"
              label="Spend · 7 days"
              value={`$${metrics.spend7d.toFixed(2)}`}
              sub={`today $${metrics.spendToday.toFixed(2)} · 14d trend`}
              aside={
                <Sparkline
                  points={metrics.spendSeries14d}
                  className="text-primary"
                  label="Daily spend, last 14 days"
                />
              }
            />
            <StatTile
              label="Runs · 7d"
              value={metrics.runs7d.completed + metrics.runs7d.failed}
              sub={
                metrics.runs7d.successRate === null
                  ? "no runs yet"
                  : `${Math.round(metrics.runs7d.successRate * 100)}% success · ${metrics.runs7d.failed} failure${metrics.runs7d.failed !== 1 ? "s" : ""}`
              }
            />
            <StatTile
              label="PRs · 7d"
              value={metrics.prs7d}
              sub="opened by runs"
            />
            <StatTile
              label="Machines"
              value={
                <span
                  className={
                    metrics.sandboxes.cloud > 0 ? "text-amber-300" : undefined
                  }
                >
                  {metrics.sandboxes.cloud}
                </span>
              }
              sub={`cloud (billing) · ${metrics.sandboxes.local} local`}
            />
            <StatTile
              label="In review"
              value={metrics.featuresInReview}
              sub={`features · ${metrics.plansAwaiting} plan${metrics.plansAwaiting !== 1 ? "s" : ""} awaiting approval`}
            />
          </div>

          {/* Title + summary */}
          <div className="flex items-baseline justify-between">
            <h1 className="text-[22px] font-semibold">Projects</h1>
            <p className="font-mono text-[11px] text-muted-foreground">
              {data.projects.length} project
              {data.projects.length !== 1 ? "s" : ""} ·{" "}
              {data.activeSandboxes.length} sandbox
              {data.activeSandboxes.length !== 1 ? "es" : ""} up ·{" "}
              {data.runningTaskCount} task
              {data.runningTaskCount !== 1 ? "s" : ""} running
            </p>
          </div>

          {/* Project cards — 3-up full width (prototype), activity below. */}
          <div className="space-y-6">
            <div className="space-y-3">
              {data.projects.length === 0 && (
                <Card className="border-border/50">
                  <CardContent className="flex flex-col items-center gap-3 py-10 text-center">
                    <FolderKanban className="h-6 w-6 text-muted-foreground" />
                    <p className="text-xs text-muted-foreground">
                      No projects yet — create the first one with the wizard.
                    </p>
                    <Button size="sm" render={<Link href="/projects/new" />}>
                      New Project
                    </Button>
                  </CardContent>
                </Card>
              )}
              <div className="grid grid-cols-1 gap-3.5 md:grid-cols-2 xl:grid-cols-3">
                {data.projects.map((p) => {
                  const state = p.runningTask
                    ? { label: "● task running", className: "text-primary" }
                    : p.sandboxes.some((s) => s.status === "provisioning")
                      ? { label: "provisioning", className: "text-amber-400" }
                      : p.sandboxes.length > 0
                        ? { label: "sandbox up", className: "text-primary" }
                        : { label: "idle", className: "text-muted-foreground" };
                  return (
                    <Link key={p.id} href={`/projects/${p.id}`}>
                      <Card className="group h-full border-border/50 hover:border-primary/40 transition-colors">
                        <CardContent className="p-4 space-y-2">
                          <div className="flex items-center justify-between gap-2">
                            <span className="text-sm font-semibold truncate">
                              {p.name}
                            </span>
                            <span
                              className={`font-mono text-[10px] whitespace-nowrap ${state.className}`}
                            >
                              {state.label}
                            </span>
                          </div>
                          <p className="font-mono text-[11px] text-muted-foreground">
                            {p.repos} repo{p.repos !== 1 ? "s" : ""}
                            {p.services > 0
                              ? ` · ${p.services} service${p.services !== 1 ? "s" : ""}`
                              : " · no stack"}
                            {p.embeddings > 0
                              ? ` · ${p.embeddings.toLocaleString()} sources indexed`
                              : " · not indexed"}
                          </p>
                          {/* Setup progress bar (prototype) */}
                          <div className="h-[5px] overflow-hidden rounded-full bg-muted">
                            <div
                              className="h-full rounded-full"
                              style={{
                                width: `${Math.round((p.setupDone / p.setupTotal) * 100)}%`,
                                background:
                                  "linear-gradient(90deg, oklch(0.6 0.13 300), oklch(0.8 0.15 300))",
                              }}
                            />
                          </div>
                          <div className="flex flex-wrap gap-1.5">
                            <Badge variant="secondary" className="text-[10px]">
                              setup {p.setupDone}/{p.setupTotal}
                            </Badge>
                            <Badge variant="secondary" className="text-[10px]">
                              {p.features} features
                            </Badge>
                            {p.sandboxes.map((s) => (
                              <Badge
                                key={s.id}
                                variant="outline"
                                className="text-[10px] text-primary border-primary/30"
                              >
                                {s.status === "running"
                                  ? "sandbox up"
                                  : "provisioning…"}
                              </Badge>
                            ))}
                          </div>
                        </CardContent>
                      </Card>
                    </Link>
                  );
                })}
              </div>
            </div>

            {/* Below the cards: Activity (1.3fr) + Active sandboxes (1fr) */}
            <div className="flex flex-col gap-3.5 lg:flex-row">
              <div className="lg:flex-[1.3] min-w-0">
                <Card className="border-border/50 h-full">
                  <CardContent className="p-4">
                    <h2 className="mb-3 flex items-center gap-1.5 font-mono text-[11px] uppercase tracking-[0.14em] text-muted-foreground">
                      <Activity className="h-3 w-3" />
                      Activity
                    </h2>
                    {data.activity.length === 0 && (
                      <p className="p-3 text-xs text-muted-foreground">
                        No activity yet — launch a sandbox or run a
                        feature.
                      </p>
                    )}
                    <div className="divide-y divide-border/40">
                      {data.activity.map((a) => {
                        const meta = ACTIVITY_ICON[a.kind];
                        return (
                          <Link
                            key={a.id}
                            href={`/projects/${a.projectId}`}
                            className="flex items-start gap-2.5 px-2 py-2 hover:bg-muted/30 rounded-md transition-colors"
                          >
                            <meta.icon
                              className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${meta.className} ${a.kind === "task-running" ? "animate-spin" : ""}`}
                            />
                            <div className="min-w-0 flex-1">
                              <p className="truncate text-xs">{a.text}</p>
                              <p className="font-mono text-[10px] text-muted-foreground">
                                {formatDistanceToNow(a.time, {
                                  addSuffix: true,
                                })}
                              </p>
                            </div>
                          </Link>
                        );
                      })}
                    </div>
                  </CardContent>
                </Card>
              </div>

              <div className="lg:flex-1 min-w-0">
                <Card className="border-border/50 h-full">
                  <CardContent className="p-4">
                    <h2 className="mb-3 flex items-center gap-1.5 font-mono text-[11px] uppercase tracking-[0.14em] text-muted-foreground">
                      <Rocket className="h-3 w-3" />
                      Active sandboxes
                    </h2>
                    {data.activeSandboxes.length === 0 && (
                      <p className="py-1 font-mono text-[11.5px] text-muted-foreground">
                        none — launch one from a project
                      </p>
                    )}
                    <div className="divide-y divide-border/40">
                      {data.activeSandboxes.map((s) => (
                        <Link
                          key={s.id}
                          href={`/projects/${s.project.id}?tab=sandboxes`}
                          className="flex items-center gap-2.5 px-2 py-2 hover:bg-muted/30 rounded-md transition-colors"
                        >
                          {s.status === "running" ? (
                            <CircleDot className="h-3.5 w-3.5 shrink-0 text-primary" />
                          ) : (
                            <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-amber-400" />
                          )}
                          <div className="min-w-0 flex-1">
                            <p className="truncate font-mono text-xs">
                              {s.name}
                            </p>
                            <p className="font-mono text-[10px] text-muted-foreground">
                              {s.project.name} ·{" "}
                              {s.status === "running"
                                ? `up ${formatDistanceToNow(s.createdAt)}`
                                : "provisioning"}
                            </p>
                          </div>
                          <span className="flex items-center gap-1 text-muted-foreground">
                            <Terminal className="h-3 w-3" />
                            <ArrowRight className="h-3 w-3" />
                          </span>
                        </Link>
                      ))}
                    </div>
                  </CardContent>
                </Card>
              </div>
            </div>
          </div>
        </div>
        </div>
      </div>
    </>
  );
}
