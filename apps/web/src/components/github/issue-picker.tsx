"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
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
import {
  CircleCheck,
  CircleDot,
  ExternalLink,
  GitBranch,
  Loader2,
  RefreshCw,
  Search,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";

interface GitHubAccount {
  id: string;
  label: string;
  status: string;
  metadata: { login: string; avatar_url: string } | null;
}

interface GitHubRepo {
  id: number;
  name: string;
  full_name: string;
  owner: { login: string };
  open_issues_count: number;
}

interface Issue {
  id: string;
  issueNumber: number;
  title: string;
  body: string | null;
  state: string;
  url: string;
  author: string | null;
  labels: { name: string; color: string }[] | null;
  milestone: string | null;
}

interface LinkedIssue {
  id: string;
  issue: Issue;
}

interface IssuePickerProps {
  projectId: string;
  featureId: string;
}

function IssueStateIcon({ state }: { state: string }) {
  return state === "open" ? (
    <CircleDot className="h-3.5 w-3.5 text-green-500 shrink-0" />
  ) : (
    <CircleCheck className="h-3.5 w-3.5 text-purple-500 shrink-0" />
  );
}

function LabelBadge({ label }: { label: { name: string; color: string } }) {
  return (
    <span
      className="inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium"
      style={{
        backgroundColor: `#${label.color}22`,
        color: `#${label.color}`,
        border: `1px solid #${label.color}44`,
      }}
    >
      {label.name}
    </span>
  );
}

export function LinkedIssuesList({
  projectId,
  featureId,
}: IssuePickerProps) {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const { data: linked = [], isLoading } = useQuery<LinkedIssue[]>({
    queryKey: ["feature-issues", featureId],
    queryFn: async () => {
      const res = await fetch(
        `/api/projects/${projectId}/features/${featureId}/issues`
      );
      if (!res.ok) throw new Error("Failed to load linked issues");
      return res.json();
    },
  });

  const unlinkMutation = useMutation({
    mutationFn: async (issueId: string) => {
      const res = await fetch(
        `/api/projects/${projectId}/features/${featureId}/issues?issueId=${issueId}`,
        { method: "DELETE" }
      );
      if (!res.ok) throw new Error("Failed to unlink issue");
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["feature-issues", featureId] });
    },
    onError: (err: Error) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  if (isLoading) return null;
  if (linked.length === 0) return null;

  return (
    <div className="space-y-1.5">
      {linked.map(({ id, issue }) => (
        <div
          key={id}
          className="flex items-start gap-2 text-sm group rounded-md px-2 py-1.5 hover:bg-muted/50"
        >
          <IssueStateIcon state={issue.state} />
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
                #{issue.issueNumber}
              </span>
              {issue.labels?.slice(0, 3).map((l) => (
                <LabelBadge key={l.name} label={l} />
              ))}
            </div>
          </div>
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6 opacity-0 group-hover:opacity-100 shrink-0"
            onClick={() => unlinkMutation.mutate(issue.id)}
            disabled={unlinkMutation.isPending}
          >
          </Button>
        </div>
      ))}
    </div>
  );
}

export function IssuePicker({ projectId, featureId }: IssuePickerProps) {
  const [open, setOpen] = useState(false);
  const [selectedAccount, setSelectedAccount] = useState<string>("");
  const [selectedRepo, setSelectedRepo] = useState<string>("");
  const [search, setSearch] = useState("");
  const [stateFilter, setStateFilter] = useState<"open" | "closed" | "all">("open");
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data: accounts = [] } = useQuery<GitHubAccount[]>({
    queryKey: ["github-accounts"],
    queryFn: async () => {
      const res = await fetch("/api/github/accounts");
      if (!res.ok) throw new Error("Failed to load accounts");
      return res.json();
    },
    enabled: open,
  });

  const { data: repos = [], isLoading: reposLoading } = useQuery<GitHubRepo[]>({
    queryKey: ["github-repos", selectedAccount],
    queryFn: async () => {
      const res = await fetch(`/api/github/accounts/${selectedAccount}/repos`);
      if (!res.ok) throw new Error("Failed to load repos");
      return res.json();
    },
    enabled: !!selectedAccount,
  });

  const { data: issues = [], isLoading: issuesLoading } = useQuery<Issue[]>({
    queryKey: ["github-issues", selectedAccount, selectedRepo, stateFilter, search],
    queryFn: async () => {
      const [owner, repo] = selectedRepo.split("/");
      const params = new URLSearchParams({
        accountId: selectedAccount,
        owner,
        repo,
        state: stateFilter,
        ...(search ? { search } : {}),
      });
      const res = await fetch(`/api/github/issues?${params}`);
      if (!res.ok) throw new Error("Failed to load issues");
      return res.json();
    },
    enabled: !!selectedAccount && !!selectedRepo,
  });

  const syncMutation = useMutation({
    mutationFn: async () => {
      const [owner, repo] = selectedRepo.split("/");
      const res = await fetch(`/api/github/accounts/${selectedAccount}/sync`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ owner, repo, state: "all" }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Sync failed");
      }
      return res.json();
    },
    onSuccess: (data) => {
      toast({ title: `Synced ${data.synced} issues from ${data.repo}` });
      queryClient.invalidateQueries({
        queryKey: ["github-issues", selectedAccount, selectedRepo],
      });
    },
    onError: (err: Error) => {
      toast({ title: "Sync failed", description: err.message, variant: "destructive" });
    },
  });

  const linkMutation = useMutation({
    mutationFn: async (issueId: string) => {
      const res = await fetch(
        `/api/projects/${projectId}/features/${featureId}/issues`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ issueId }),
        }
      );
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Failed to link issue");
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["feature-issues", featureId] });
      toast({ title: "Issue linked to feature" });
    },
    onError: (err: Error) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const { data: linked = [] } = useQuery<LinkedIssue[]>({
    queryKey: ["feature-issues", featureId],
    queryFn: async () => {
      const res = await fetch(
        `/api/projects/${projectId}/features/${featureId}/issues`
      );
      if (!res.ok) throw new Error("Failed to load linked issues");
      return res.json();
    },
    enabled: open,
  });

  const linkedIds = new Set(linked.map((l) => l.issue.id));

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger nativeButton render={<Button variant="outline" size="sm" className="gap-1.5" />}>
        <GitBranch className="h-3.5 w-3.5" />
        Link Issues
      </DialogTrigger>
      <DialogContent className="sm:max-w-2xl max-h-[90vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <GitBranch className="h-5 w-5" />
            Link GitHub Issues
          </DialogTitle>
          <DialogDescription>
            Select issues from your GitHub repositories to associate with this feature.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3 flex-1 min-h-0">
          {/* Filters row */}
          <div className="flex gap-2 flex-wrap">
            <Select
              value={selectedAccount}
              onValueChange={(v) => {
                setSelectedAccount(v ?? "");
                setSelectedRepo("");
              }}
            >
              <SelectTrigger className="w-44">
                <SelectValue placeholder="Select account" />
              </SelectTrigger>
              <SelectContent>
                {accounts.map((a) => (
                  <SelectItem key={a.id} value={a.id}>
                    {a.label}
                    {a.metadata?.login && (
                      <span className="text-muted-foreground ml-1">
                        (@{a.metadata.login})
                      </span>
                    )}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Select
              value={selectedRepo}
              onValueChange={(v) => setSelectedRepo(v ?? "")}
              disabled={!selectedAccount || reposLoading}
            >
              <SelectTrigger className="flex-1 min-w-40">
                <SelectValue
                  placeholder={reposLoading ? "Loading repos..." : "Select repository"}
                />
              </SelectTrigger>
              <SelectContent>
                {repos.map((r) => (
                  <SelectItem key={r.id} value={r.full_name}>
                    {r.full_name}
                    {r.open_issues_count > 0 && (
                      <span className="text-muted-foreground ml-1">
                        ({r.open_issues_count})
                      </span>
                    )}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Select
              value={stateFilter}
              onValueChange={(v) => v && setStateFilter(v)}
              disabled={!selectedRepo}
            >
              <SelectTrigger className="w-28">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="open">Open</SelectItem>
                <SelectItem value="closed">Closed</SelectItem>
                <SelectItem value="all">All</SelectItem>
              </SelectContent>
            </Select>

            {selectedRepo && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => syncMutation.mutate()}
                disabled={syncMutation.isPending}
                title="Sync issues from GitHub"
              >
                {syncMutation.isPending ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <RefreshCw className="h-4 w-4" />
                )}
              </Button>
            )}
          </div>

          {/* Search */}
          {selectedRepo && (
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

          {/* Issues list */}
          <ScrollArea className="flex-1 min-h-0 border rounded-md">
            {!selectedAccount ? (
              <div className="py-12 text-center text-sm text-muted-foreground">
                <GitBranch className="h-8 w-8 mx-auto mb-2 opacity-40" />
                Select a GitHub account to get started.
                <br />
                <a
                  href="/settings"
                  className="text-primary hover:underline mt-1 inline-block"
                >
                  Add an account in Settings →
                </a>
              </div>
            ) : !selectedRepo ? (
              <div className="py-12 text-center text-sm text-muted-foreground">
                Select a repository to browse issues.
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
                  Sync from GitHub →
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
                      <IssueStateIcon state={issue.state} />
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
                            #{issue.issueNumber}
                          </span>
                          {issue.author && (
                            <span className="text-xs text-muted-foreground">
                              by {issue.author}
                            </span>
                          )}
                          {issue.labels?.slice(0, 3).map((l) => (
                            <LabelBadge key={l.name} label={l} />
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
                        onClick={() => !isLinked && linkMutation.mutate(issue.id)}
                        disabled={isLinked || linkMutation.isPending}
                      >
                        {isLinked ? (
                          "Linked"
                        ) : (
                          <>
                            Link
                          </>
                        )}
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
