"use client";

// The project chat's Pull requests surface (spec 39), in the spirit of T3
// Code's "Linked items": every repository's recent PRs (GitHub) and merge
// requests (GitLab), newest first — state, number, title, author, repo,
// branch → target, when. A click opens it on its site.

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { formatDistanceToNowStrict } from "date-fns";
import { GitMerge, GitPullRequest, GitPullRequestClosed, GitPullRequestDraft, Loader2, RefreshCw } from "lucide-react";

import { Button } from "@/components/ui/button";
import type { PullRequest } from "@/lib/project-prs";
import { cn } from "@/lib/utils";
import { openExternal } from "@/services/updates";

type Result = { items: PullRequest[]; errors: { repo: string; error: string }[]; skipped: string[] };

export function useProjectPullRequests(projectId: string) {
  return useQuery({
    queryKey: ["project-prs", projectId],
    queryFn: async () => {
      const res = await fetch(`/api/projects/${projectId}/pull-requests`);
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Could not load pull requests");
      return body as Result;
    },
    staleTime: 60_000,
  });
}

export const PR_STATE: Record<PullRequest["state"], { icon: typeof GitPullRequest; tint: string; label: string }> = {
  open: { icon: GitPullRequest, tint: "text-emerald-400", label: "Open" },
  draft: { icon: GitPullRequestDraft, tint: "text-muted-foreground", label: "Draft" },
  merged: { icon: GitMerge, tint: "text-violet-400", label: "Merged" },
  closed: { icon: GitPullRequestClosed, tint: "text-red-400", label: "Closed" },
};

export function PullRequestRow({ pr, compact = false }: { pr: PullRequest; compact?: boolean }) {
  const s = PR_STATE[pr.state];
  return (
    <button
      type="button"
      onClick={() => void openExternal(pr.url)}
      title={compact ? `${pr.repo} · ${pr.source} → ${pr.target}` : undefined}
      className="flex w-full items-start gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-accent/60"
    >
      <s.icon className={cn("mt-0.5 h-4 w-4 shrink-0", s.tint)} />
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-1.5 text-[13px]">
          <span className="shrink-0 font-mono text-[11.5px] text-muted-foreground">
            {pr.provider === "gitlab" ? "!" : "#"}
            {pr.number}
          </span>
          <span className="truncate">{pr.title}</span>
        </span>
        {!compact && (
          <span className="flex items-center gap-1.5 truncate text-[11px] text-muted-foreground">
            {pr.authorAvatar && <img src={pr.authorAvatar} alt="" className="h-3.5 w-3.5 rounded-full" />}
            <span className="truncate">{pr.author ?? "—"}</span>
            <span className="shrink-0">·</span>
            <span className="truncate font-mono">{pr.repo}</span>
            <span className="truncate font-mono">
              {pr.source} → {pr.target}
            </span>
          </span>
        )}
      </span>
      <span className="shrink-0 text-[11px] text-muted-foreground">
        {formatDistanceToNowStrict(new Date(pr.updatedAt), { addSuffix: false })}
      </span>
    </button>
  );
}

export function PullRequestsSurface({ projectId }: { projectId: string }) {
  const prs = useProjectPullRequests(projectId);
  const [filter, setFilter] = useState<"open" | "all">("open");
  const all = prs.data?.items ?? [];
  const open = all.filter((p) => p.state === "open" || p.state === "draft");
  const shown = filter === "open" ? open : all;

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-1 border-b border-border px-2 py-1.5 text-[12px]">
        {(
          [
            ["open", `Open · ${open.length}`],
            ["all", `All · ${all.length}`],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            onClick={() => setFilter(id)}
            className={cn("rounded-md px-2.5 py-1", filter === id ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground")}
          >
            {label}
          </button>
        ))}
        <Button size="icon-sm" variant="ghost" className="ml-auto rounded-md" onClick={() => prs.refetch()} aria-label="Refresh">
          <RefreshCw className={cn("h-3.5 w-3.5", prs.isFetching && "animate-spin")} />
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-1">
        {prs.isLoading && (
          <div className="flex justify-center py-8">
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
          </div>
        )}
        {prs.isError && <p className="px-3 py-3 text-[12.5px] text-destructive">{(prs.error as Error).message}</p>}
        {prs.data && shown.length === 0 && (
          <p className="px-3 py-6 text-center text-[12.5px] text-muted-foreground">
            {filter === "open" ? "No open pull requests." : "No pull requests yet."}
          </p>
        )}
        {shown.map((pr) => (
          <PullRequestRow key={pr.url} pr={pr} />
        ))}
        {(prs.data?.errors.length ?? 0) > 0 && (
          <div className="mx-2 mt-2 space-y-1 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-[11.5px] text-muted-foreground">
            {prs.data!.errors.map((e) => (
              <p key={e.repo}>
                <span className="font-mono text-foreground">{e.repo}</span>: {e.error} — check its token in Vault → Git.
              </p>
            ))}
          </div>
        )}
      </div>
      <footer className="flex h-7 shrink-0 items-center border-t border-border px-3 text-[11px] text-muted-foreground">
        {open.length} open · {all.length} recent
        {prs.dataUpdatedAt ? ` · synced ${formatDistanceToNowStrict(prs.dataUpdatedAt)} ago` : ""}
      </footer>
    </div>
  );
}
