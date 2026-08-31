"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { BrandIcon } from "@/components/ui/brand-icon";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ScrollArea } from "@/components/ui/scroll-area";
import { ExternalLink, Loader2, RefreshCw, Search, X } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import {
  type CachedGitLabIssue,
  type GitLabProjectSummary,
  GitLabAccountSelect,
  GitLabLabelBadge,
  GitLabProjectPicker,
  GitLabStateIcon,
  NoGitLabServer,
  useGitLabAccounts,
} from "./gitlab-shared";

interface LinkedGitLabIssue {
  id: string;
  issue: CachedGitLabIssue;
}

interface PickerProps {
  projectId: string;
  featureId: string;
}

function linkedQueryKey(featureId: string) {
  return ["feature-gitlab-issues", featureId] as const;
}

async function fetchLinked(
  projectId: string,
  featureId: string,
): Promise<LinkedGitLabIssue[]> {
  const res = await fetch(
    `/api/projects/${projectId}/features/${featureId}/gitlab-issues`,
  );
  if (!res.ok) throw new Error("Failed to load linked issues");
  return res.json();
}

export function LinkedGitLabIssuesList({ projectId, featureId }: PickerProps) {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const { data: linked = [], isLoading } = useQuery<LinkedGitLabIssue[]>({
    queryKey: linkedQueryKey(featureId),
    queryFn: () => fetchLinked(projectId, featureId),
  });

  const unlinkMutation = useMutation({
    mutationFn: async (issueId: string) => {
      const res = await fetch(
        `/api/projects/${projectId}/features/${featureId}/gitlab-issues?issueId=${issueId}`,
        { method: "DELETE" },
      );
      if (!res.ok) throw new Error("Failed to unlink issue");
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: linkedQueryKey(featureId) });
    },
    onError: (err: Error) => {
      toast({
        title: "Error",
        description: err.message,
        variant: "destructive",
      });
    },
  });

  if (isLoading || linked.length === 0) return null;

  return (
    <div className="space-y-1.5">
      {linked.map(({ id, issue }) => (
        <div
          key={id}
          className="flex items-start gap-2 text-sm group rounded-md px-2 py-1.5 hover:bg-muted/50"
        >
          <GitLabStateIcon state={issue.state} />
          <div className="flex-1 min-w-0">
            <a
              href={issue.url}
              target="_blank"
              rel="noopener noreferrer"
              className="font-medium hover:underline line-clamp-1 text-foreground"
            >
              {issue.title}
            </a>
            <div className="flex items-center gap-1 mt-0.5 flex-wrap">
              <span className="text-xs text-muted-foreground">
                {issue.projectPath}#{issue.issueIid}
              </span>
              {issue.labels?.slice(0, 3).map((l) => (
                <GitLabLabelBadge key={l} label={l} />
              ))}
            </div>
          </div>
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6 opacity-0 group-hover:opacity-100 shrink-0"
            onClick={() => unlinkMutation.mutate(issue.id)}
            disabled={unlinkMutation.isPending}
            title="Unlink issue"
          >
            <X className="h-3.5 w-3.5" />
          </Button>
        </div>
      ))}
    </div>
  );
}

export function GitLabIssuePicker({ projectId, featureId }: PickerProps) {
  const [open, setOpen] = useState(false);
  const [accountId, setAccountId] = useState("");
  const [project, setProject] = useState<GitLabProjectSummary | null>(null);
  const [search, setSearch] = useState("");
  const [stateFilter, setStateFilter] = useState<"opened" | "closed" | "all">(
    "opened",
  );
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data: accounts = [] } = useGitLabAccounts(open);

  const { data: issues = [], isLoading: issuesLoading } = useQuery<
    CachedGitLabIssue[]
  >({
    queryKey: ["gitlab-issues", accountId, project?.id, stateFilter, search],
    queryFn: async () => {
      const params = new URLSearchParams({
        accountId,
        projectId: String(project!.id),
        state: stateFilter,
        ...(search ? { search } : {}),
      });
      const res = await fetch(`/api/gitlab/issues?${params}`);
      if (!res.ok) throw new Error("Failed to load issues");
      return res.json();
    },
    enabled: !!accountId && !!project,
  });

  const syncMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/gitlab/accounts/${accountId}/sync`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId: project!.id,
          projectPath: project!.path_with_namespace,
          state: "all",
        }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Sync failed");
      }
      return res.json() as Promise<{ synced: number; projectPath: string }>;
    },
    onSuccess: (data) => {
      toast({
        title: `Synced ${data.synced} issues from ${data.projectPath}`,
      });
      queryClient.invalidateQueries({
        queryKey: ["gitlab-issues", accountId, project?.id],
      });
    },
    onError: (err: Error) => {
      toast({
        title: "Sync failed",
        description: err.message,
        variant: "destructive",
      });
    },
  });

  const linkMutation = useMutation({
    mutationFn: async (issueId: string) => {
      const res = await fetch(
        `/api/projects/${projectId}/features/${featureId}/gitlab-issues`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ issueId }),
        },
      );
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Failed to link issue");
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: linkedQueryKey(featureId) });
      toast({ title: "Issue linked to feature" });
    },
    onError: (err: Error) => {
      toast({
        title: "Error",
        description: err.message,
        variant: "destructive",
      });
    },
  });

  const { data: linked = [] } = useQuery<LinkedGitLabIssue[]>({
    queryKey: linkedQueryKey(featureId),
    queryFn: () => fetchLinked(projectId, featureId),
    enabled: open,
  });

  const linkedIds = new Set(linked.map((l) => l.issue.id));

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        nativeButton
        render={<Button variant="outline" size="sm" className="gap-1.5" />}
      >
        <BrandIcon brand="gitlab" className="h-3.5 w-3.5" />
        Link GitLab Issues
      </DialogTrigger>
      <DialogContent className="sm:max-w-2xl max-h-[90vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <BrandIcon brand="gitlab" className="h-5 w-5" />
            Link GitLab issues
          </DialogTitle>
          <DialogDescription>
            Attach issues from any connected GitLab server to this feature.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3 flex-1 min-h-0">
          <div className="flex gap-2 flex-wrap">
            <GitLabAccountSelect
              accounts={accounts}
              value={accountId}
              onChange={(v) => {
                setAccountId(v);
                setProject(null);
              }}
            />

            <GitLabProjectPicker
              accountId={accountId}
              value={project}
              onChange={setProject}
            />

            <Select
              value={stateFilter}
              onValueChange={(v) => v && setStateFilter(v)}
              disabled={!project}
            >
              <SelectTrigger className="w-28">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="opened">Open</SelectItem>
                <SelectItem value="closed">Closed</SelectItem>
                <SelectItem value="all">All</SelectItem>
              </SelectContent>
            </Select>

            {project && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => syncMutation.mutate()}
                disabled={syncMutation.isPending}
                title="Sync issues from GitLab"
              >
                {syncMutation.isPending ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <RefreshCw className="h-4 w-4" />
                )}
              </Button>
            )}
          </div>

          {project && (
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Search issues..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="pl-9"
              />
            </div>
          )}

          <ScrollArea className="flex-1 min-h-0 border rounded-md">
            {!accountId ? (
              <NoGitLabServer action="browse issues" />
            ) : !project ? (
              <div className="py-12 text-center text-sm text-muted-foreground">
                Pick a project to browse its issues.
              </div>
            ) : issuesLoading ? (
              <div className="py-12 flex items-center justify-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                Loading issues...
              </div>
            ) : issues.length === 0 ? (
              <div className="py-12 text-center text-sm text-muted-foreground">
                No issues found.
                <br />
                <button
                  onClick={() => syncMutation.mutate()}
                  className="text-primary hover:underline mt-1"
                  disabled={syncMutation.isPending}
                >
                  Sync from GitLab →
                </button>
              </div>
            ) : (
              <div className="divide-y">
                {issues.map((issue) => {
                  const isLinked = linkedIds.has(issue.id);
                  return (
                    <div
                      key={issue.id}
                      className="flex items-start gap-3 px-3 py-2.5 hover:bg-muted/40"
                    >
                      <GitLabStateIcon state={issue.state} />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-start gap-2">
                          <span className="text-sm font-medium line-clamp-1 flex-1">
                            {issue.title}
                          </span>
                          <a
                            href={issue.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="shrink-0 text-muted-foreground hover:text-foreground"
                            onClick={(e) => e.stopPropagation()}
                          >
                            <ExternalLink className="h-3.5 w-3.5" />
                          </a>
                        </div>
                        <div className="flex items-center gap-1.5 mt-0.5 flex-wrap">
                          <span className="text-xs text-muted-foreground">
                            #{issue.issueIid}
                          </span>
                          {issue.author && (
                            <span className="text-xs text-muted-foreground">
                              by {issue.author}
                            </span>
                          )}
                          {issue.labels?.slice(0, 3).map((l) => (
                            <GitLabLabelBadge key={l} label={l} />
                          ))}
                          {issue.milestone && (
                            <Badge variant="outline" className="text-xs py-0">
                              {issue.milestone}
                            </Badge>
                          )}
                        </div>
                      </div>
                      <Button
                        size="sm"
                        variant={isLinked ? "secondary" : "outline"}
                        className="shrink-0 h-7 text-xs"
                        onClick={() =>
                          !isLinked && linkMutation.mutate(issue.id)
                        }
                        disabled={isLinked || linkMutation.isPending}
                      >
                        {isLinked ? "Linked" : "Link"}
                      </Button>
                    </div>
                  );
                })}
              </div>
            )}
          </ScrollArea>
        </div>
      </DialogContent>
    </Dialog>
  );
}
