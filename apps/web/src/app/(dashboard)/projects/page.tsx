"use client";

// The project shelf: every project with its live state on its sleeve. The
// hero counts the workspace's pulse (projects, sandboxes up, tasks running),
// pills cut the grid by that same state, and each card wears its status as
// a hairline — running beats primary, a live sandbox glows emerald, idle
// stays quiet.

import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { formatDistanceToNow } from "date-fns";
import {
  ArrowRight,
  FolderKanban,
  Loader2,
  Plus,
  Search,
} from "lucide-react";

import { AppHeader } from "@/components/layout/app-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Sparkline } from "@/components/ui/sparkline";
import { StatTile } from "@/components/ui/stat-tile";
import { cn } from "@/lib/utils";
import type { WorkspaceMetrics } from "@/lib/metrics";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

type ProjectOverview = {
  id: string;
  name: string;
  description: string | null;
  updatedAt: string;
  repos: number;
  features: number;
  stackNames: string[];
  techs: string[];
  embeddings: number;
  sandboxUp: boolean;
  runningTasks: number;
  lastPrUrl: string | null;
  setupDone: number;
  setupTotal: number;
};

async function getProjectOverview(): Promise<ProjectOverview[]> {
  const res = await fetch("/api/projects/overview");
  if (!res.ok) throw new Error("Failed to load projects");
  return res.json();
}

type RecentTask = {
  id: string;
  kind: string;
  status: string;
  title: string;
  prUrl: string | null;
  previewUrl: string | null;
  costUsd: number | null;
  createdAt: string;
  provider: string;
  projectId: string;
  projectName: string;
};

async function getMetrics(): Promise<WorkspaceMetrics | null> {
  const res = await fetch("/api/metrics");
  if (!res.ok) throw new Error("Failed to load metrics");
  return asWorkspaceMetrics(await res.json());
}

/**
 * The workspace pulse, or null when the response is not it.
 *
 * `/api/metrics` used to serve these numbers and now serves the machine's own
 * (memory, CPU, disk — D-?, PR #8); this page was never moved off it. The
 * mismatch did not show up as a blank tile: `spend7d` came back undefined,
 * `.toFixed(2)` threw *during render*, and React unmounted the whole route —
 * so the entire projects page read "This page couldn't load" because four
 * decorative tiles could not find their numbers.
 *
 * Hence a shape check rather than a `?? 0` per field: a missing number renders
 * nothing, and the tiles can never again take the page down with them. The
 * real fix is a route that serves this shape again, which nothing does today —
 * `getWorkspaceMetrics()` in lib/metrics.ts is orphaned.
 */
function asWorkspaceMetrics(raw: unknown): WorkspaceMetrics | null {
  const m = raw as Partial<WorkspaceMetrics> | null;
  if (!m || typeof m !== "object") return null;
  const complete =
    typeof m.spend7d === "number" &&
    typeof m.spendToday === "number" &&
    Array.isArray(m.spendSeries14d) &&
    typeof m.prs7d === "number" &&
    typeof m.runs7d?.completed === "number" &&
    typeof m.runs7d?.failed === "number" &&
    typeof m.sandboxes?.cloud === "number" &&
    typeof m.sandboxes?.local === "number";
  return complete ? (m as WorkspaceMetrics) : null;
}

async function getRecentTasks(): Promise<RecentTask[]> {
  const res = await fetch("/api/tasks?limit=20");
  if (!res.ok) throw new Error("Failed to load tasks");
  return res.json();
}

type StateFilter = "all" | "running" | "up" | "idle";

/** Live state of a project, worn by the card's hairline and status line. */
function stateOf(p: ProjectOverview): {
  id: Exclude<StateFilter, "all">;
  label: string;
  dot: string;
  text: string;
  bar: string;
} {
  if (p.runningTasks > 0) {
    return {
      id: "running",
      label: "task running",
      dot: "bg-primary animate-pulse",
      text: "text-primary",
      bar: "bg-primary",
    };
  }
  if (p.sandboxUp) {
    return {
      id: "up",
      label: "sandbox up",
      dot: "bg-emerald-400",
      text: "text-emerald-400",
      bar: "bg-emerald-400",
    };
  }
  return {
    id: "idle",
    label: p.embeddings > 0 ? "indexed" : "idle",
    dot: "bg-muted-foreground/40",
    text: "text-muted-foreground",
    bar: "bg-muted-foreground/30",
  };
}

function NewProjectButton() {
  return (
    <Button size="sm" className="gap-1.5" render={<Link href="/projects/new" />}>
      <Plus className="h-3.5 w-3.5" />
      New Project
    </Button>
  );
}

function TaskResult({ task }: { task: RecentTask }) {
  if (task.status === "running" || task.status === "queued") {
    return (
      <span className="flex items-center gap-1.5 text-primary">
        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-primary" />
        running
      </span>
    );
  }
  if (task.status === "error") {
    return <span className="text-destructive">✗ failed</span>;
  }
  if (task.status === "canceled") {
    return <span className="text-muted-foreground">canceled</span>;
  }
  if (task.prUrl) {
    const num = task.prUrl.match(/\/(?:pull|merge_requests)\/(\d+)/)?.[1];
    return (
      <a
        href={task.prUrl}
        target="_blank"
        rel="noreferrer"
        onClick={(e) => e.stopPropagation()}
        className="text-emerald-400 underline-offset-2 hover:underline"
      >
        ✓ PR {num ? `#${num}` : ""}
      </a>
    );
  }
  return (
    <span className="text-emerald-400">
      ✓ {task.kind === "dev" ? "report" : "done"}
    </span>
  );
}

function ProjectCard({ p, index }: { p: ProjectOverview; index: number }) {
  const status = stateOf(p);
  const prNum = p.lastPrUrl?.match(/\/(?:pull|merge_requests)\/(\d+)/)?.[1];
  return (
    <Link
      href={`/projects/${p.id}`}
      className="group animate-in fade-in slide-in-from-bottom-2 fill-mode-backwards relative flex flex-col overflow-hidden rounded-xl border border-border/50 bg-card p-5 duration-300 transition-colors hover:border-border"
      style={{ animationDelay: `${Math.min(index * 35, 350)}ms` }}
    >
      {/* Live state as a hairline. */}
      <span
        className={cn(
          "absolute top-4 bottom-4 left-0 w-0.5 rounded-full",
          status.bar,
        )}
      />

      {/* Eyebrow: stack + live status */}
      <div className="flex items-center justify-between gap-2">
        <span className="truncate font-mono text-[10px] tracking-[0.14em] text-primary/90 uppercase">
          {p.stackNames.length > 0
            ? p.stackNames.slice(0, 2).join(" · ")
            : p.techs.length > 0
              ? p.techs.slice(0, 2).join(" · ")
              : `${p.repos} repo${p.repos === 1 ? "" : "s"}`}
        </span>
        <span
          className={cn(
            "flex shrink-0 items-center gap-1.5 text-[10.5px]",
            status.text,
          )}
        >
          <span className={cn("h-1.5 w-1.5 rounded-full", status.dot)} />
          {status.label}
        </span>
      </div>

      <h3 className="mt-2 truncate text-lg font-semibold">{p.name}</h3>
      <p className="mt-1 line-clamp-2 min-h-[2.1rem] text-[13px] leading-snug text-muted-foreground">
        {p.description ?? " "}
      </p>

      {/* Setup progress */}
      <div className="mt-3 flex items-center gap-2.5">
        <div className="h-1 flex-1 overflow-hidden rounded-full bg-muted/60">
          <div
            className="h-full rounded-full bg-gradient-to-r from-primary/70 to-primary"
            style={{ width: `${(p.setupDone / p.setupTotal) * 100}%` }}
          />
        </div>
        <span className="font-mono text-[10.5px] text-muted-foreground">
          {p.setupDone}/{p.setupTotal}
        </span>
      </div>

      {/* Chips */}
      <div className="mt-3 flex flex-wrap gap-1.5">
        {p.stackNames.length === 0 && p.techs.length === 0 && (
          <Badge variant="secondary" className="text-[10.5px] font-normal">
            repo only
          </Badge>
        )}
        {p.techs.map((name) => (
          <Badge
            key={name}
            variant="secondary"
            className="text-[10.5px] font-normal lowercase"
          >
            {name}
          </Badge>
        ))}
        {p.stackNames.slice(0, 3).map((name) => (
          <Badge
            key={name}
            variant="secondary"
            className="text-[10.5px] font-normal lowercase"
          >
            {name}
          </Badge>
        ))}
        {p.runningTasks > 0 ? (
          <Badge className="bg-primary/20 text-[10.5px] font-medium text-primary hover:bg-primary/20">
            {p.runningTasks} task{p.runningTasks === 1 ? "" : "s"} running
          </Badge>
        ) : prNum ? (
          <Badge className="bg-primary/20 text-[10.5px] font-medium text-primary hover:bg-primary/20">
            PR #{prNum} open
          </Badge>
        ) : null}
      </div>

      {/* Footer */}
      <div className="mt-4 flex items-center gap-1.5 border-t border-border/40 pt-3 text-[11px] text-muted-foreground">
        <span>
          {p.repos} repo{p.repos === 1 ? "" : "s"}
        </span>
        <span>·</span>
        <span>
          {formatDistanceToNow(new Date(p.updatedAt), { addSuffix: true })}
        </span>
        <span className="ml-auto flex items-center gap-1 text-primary">
          Open
          <ArrowRight className="h-3 w-3 transition-transform group-hover:translate-x-0.5" />
        </span>
      </div>
    </Link>
  );
}

export default function ProjectsPage() {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [state, setState] = useState<StateFilter>("all");

  const {
    data: projects,
    isLoading,
    isError,
  } = useQuery({
    queryKey: ["projects-overview"],
    queryFn: getProjectOverview,
    refetchInterval: 15_000,
  });

  const metrics = useQuery({
    queryKey: ["workspace-metrics"],
    queryFn: getMetrics,
    refetchInterval: 30_000,
  });

  const tasks = useQuery({
    queryKey: ["recent-tasks"],
    queryFn: getRecentTasks,
    refetchInterval: (q) =>
      q.state.data?.some((t) => t.status === "running" || t.status === "queued")
        ? 4000
        : false,
  });

  const counts = useMemo(() => {
    const all = projects ?? [];
    const by = { all: all.length, running: 0, up: 0, idle: 0 };
    for (const p of all) by[stateOf(p).id]++;
    return by;
  }, [projects]);

  const filtered = useMemo(() => {
    let list = projects ?? [];
    if (state !== "all") list = list.filter((p) => stateOf(p).id === state);
    const q = query.trim().toLowerCase();
    if (!q) return list;
    return list.filter(
      (p) =>
        p.name.toLowerCase().includes(q) ||
        (p.description ?? "").toLowerCase().includes(q) ||
        p.techs.some((t) => t.toLowerCase().includes(q)) ||
        p.stackNames.some((s) => s.toLowerCase().includes(q)),
    );
  }, [projects, state, query]);

  const filterPill = (id: StateFilter, label: string) => (
    <button
      key={id}
      type="button"
      onClick={() => setState(id)}
      className={cn(
        "flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] transition-colors",
        state === id
          ? id === "up"
            ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300"
            : "border-primary/40 bg-primary/10 text-foreground"
          : "border-border/60 text-muted-foreground hover:border-border hover:text-foreground",
      )}
    >
      {label}
      <span className="font-mono text-[10px] tabular-nums opacity-70">
        {counts[id]}
      </span>
    </button>
  );

  return (
    <>
      <AppHeader title="Projects" />
      <div className="flex-1 overflow-auto">
        <div className="mx-auto w-full max-w-6xl space-y-5 px-4 py-6">
          {/* ---- Hero ---------------------------------------------------- */}
          <header className="flex flex-wrap items-start justify-between gap-4 border-b border-border/60 pb-5">
            <div className="flex items-start gap-3">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-sky-500/20 bg-sky-500/10 text-sky-400">
                <FolderKanban className="h-4.5 w-4.5" />
              </div>
              <div>
                <h1 className="text-base leading-tight font-semibold">
                  Projects
                </h1>
                <p className="mt-0.5 text-sm text-muted-foreground">
                  Every project with its live state — sandboxes, runs and
                  setup at a glance.
                </p>
              </div>
            </div>
            <NewProjectButton />
          </header>

          {/* Workspace pulse — same numbers the dashboard leads with. */}
          {metrics.data && (
            <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
              <StatTile
                label="Spend · 7 days"
                value={`$${metrics.data.spend7d.toFixed(2)}`}
                sub={`today $${metrics.data.spendToday.toFixed(2)}`}
                aside={
                  <Sparkline
                    points={metrics.data.spendSeries14d}
                    width={90}
                    height={28}
                    className="text-primary"
                    label="Daily spend, last 14 days"
                  />
                }
              />
              <StatTile
                label="Runs · 7d"
                value={metrics.data.runs7d.completed + metrics.data.runs7d.failed}
                sub={
                  metrics.data.runs7d.successRate === null
                    ? "no runs yet"
                    : `${Math.round(metrics.data.runs7d.successRate * 100)}% success`
                }
              />
              <StatTile
                label="PRs · 7d"
                value={metrics.data.prs7d}
                sub="opened by runs"
              />
              <StatTile
                label="Machines"
                value={
                  <span
                    className={
                      metrics.data.sandboxes.cloud > 0
                        ? "text-amber-300"
                        : undefined
                    }
                  >
                    {metrics.data.sandboxes.cloud}
                  </span>
                }
                sub={`cloud · ${metrics.data.sandboxes.local} local`}
              />
            </div>
          )}

          {/* ---- Toolbar ------------------------------------------------- */}
          {!isLoading && !isError && (projects?.length ?? 0) > 0 && (
            <div className="flex flex-wrap items-center gap-2">
              <div className="relative min-w-56 flex-1">
                <Search className="absolute top-1/2 left-3 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search by name, description or stack…"
                  className="h-9 pl-9 text-sm"
                />
              </div>
              <div className="flex gap-1.5">
                {filterPill("all", "All")}
                {filterPill("running", "Running")}
                {filterPill("up", "Sandbox up")}
                {filterPill("idle", "Idle")}
              </div>
            </div>
          )}

          {/* Loading state */}
          {isLoading && (
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
              {Array.from({ length: 6 }).map((_, i) => (
                <Skeleton key={i} className="h-[220px] rounded-xl" />
              ))}
            </div>
          )}

          {/* Error state */}
          {isError && (
            <div className="flex flex-col items-center justify-center py-16 text-center">
              <p className="text-sm text-destructive">
                Failed to load projects. Please try again.
              </p>
            </div>
          )}

          {/* Empty state */}
          {!isLoading && !isError && projects?.length === 0 && (
            <div className="flex flex-col items-center justify-center py-20 text-center">
              <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-xl border border-sky-500/20 bg-sky-500/10">
                <FolderKanban className="h-6 w-6 text-sky-400" />
              </div>
              <h3 className="mb-1 text-sm font-medium">No projects yet</h3>
              <p className="mb-5 text-xs text-muted-foreground">
                Create your first project to get started.
              </p>
              <NewProjectButton />
            </div>
          )}

          {/* No match */}
          {!isLoading &&
            !isError &&
            (projects?.length ?? 0) > 0 &&
            filtered.length === 0 && (
              <div className="py-12 text-center text-sm text-muted-foreground">
                Nothing matches{query.trim() ? ` "${query.trim()}"` : ""}
                {state !== "all" ? " in that state" : ""}.
              </div>
            )}

          {/* Project cards */}
          {!isLoading && !isError && filtered.length > 0 && (
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
              {filtered.map((p, i) => (
                <ProjectCard key={p.id} p={p} index={i} />
              ))}
            </div>
          )}

          {/* Recent tasks across the workspace */}
          {(tasks.data?.length ?? 0) > 0 && (
            <section className="space-y-3 pt-2">
              <div className="flex items-center gap-2">
                <span className="h-1.5 w-1.5 rounded-full bg-primary/70" />
                <h3 className="text-[11px] font-semibold tracking-[0.14em] uppercase">
                  Recent tasks
                </h3>
                <span className="font-mono text-[10px] text-muted-foreground tabular-nums">
                  {tasks.data!.length}
                </span>
                <span className="ml-2 h-px flex-1 bg-border/50" />
              </div>
              <div className="rounded-lg border border-border/50">
                <Table>
                  <TableHeader>
                    <TableRow className="hover:bg-transparent">
                      <TableHead>Task</TableHead>
                      <TableHead className="hidden sm:table-cell">
                        Project
                      </TableHead>
                      <TableHead className="hidden md:table-cell">
                        Agent
                      </TableHead>
                      <TableHead>Result</TableHead>
                      <TableHead className="text-right">Cost</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {tasks.data!.map((t) => (
                      <TableRow
                        key={t.id}
                        onClick={() =>
                          router.push(
                            `/projects/${t.projectId}?tab=${t.kind === "dev" ? "sandboxes" : "features"}`,
                          )
                        }
                        className="cursor-pointer"
                      >
                        <TableCell className="max-w-[340px]">
                          <span className="block truncate text-sm">
                            {t.title}
                          </span>
                        </TableCell>
                        <TableCell className="hidden text-xs text-muted-foreground sm:table-cell">
                          {t.projectName}
                        </TableCell>
                        <TableCell className="hidden text-xs text-muted-foreground md:table-cell">
                          Claude{t.kind === "dev" ? " · dev" : ""}
                        </TableCell>
                        <TableCell className="text-xs">
                          <TaskResult task={t} />
                        </TableCell>
                        <TableCell className="text-right font-mono text-xs text-muted-foreground">
                          {t.status === "running" || t.status === "queued" ? (
                            <Loader2 className="ml-auto h-3 w-3 animate-spin" />
                          ) : t.costUsd != null ? (
                            `$${t.costUsd.toFixed(2)}`
                          ) : t.provider === "local" ? (
                            "local"
                          ) : (
                            "—"
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </section>
          )}
        </div>
      </div>
    </>
  );
}
