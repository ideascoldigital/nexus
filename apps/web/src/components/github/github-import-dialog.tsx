"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
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
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Check,
  ChevronsUpDown,
  CircleCheck,
  CircleDot,
  ExternalLink,
  GitBranch,
  Loader2,
  RefreshCw,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";

interface GitHubAccount {
  id: string;
  label: string;
  metadata: { login: string } | null;
}

interface GitHubRepo {
  id: number;
  name: string;
  full_name: string;
  open_issues_count: number;
}

interface CachedIssue {
  id: string;
  issueNumber: number;
  title: string;
  body: string | null;
  state: string;
  url: string;
  labels: { name: string; color: string }[] | null;
  milestone: string | null;
}

interface ReviewIssue {
  issueId: string;
  included: boolean;
  title: string;
  description: string;
  status: string;
  state: string;
  issueNumber: number;
  url: string;
  milestone: string | null;
}

export function GitHubImportDialog({
  projectId,
  open: controlledOpen,
  onOpenChange,
}: {
  projectId: string;
  /** Controlled mode (no trigger button) — used by the Import menu. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const [internalOpen, setInternalOpen] = useState(false);
  const open = controlledOpen ?? internalOpen;
  const setOpen = (o: boolean) => {
    setInternalOpen(o);
    onOpenChange?.(o);
  };
  const [accountId, setAccountId] = useState("");
  const [repoFullName, setRepoFullName] = useState("");
  const [repoPickerOpen, setRepoPickerOpen] = useState(false);
  const [phaseName, setPhaseName] = useState("");
  const [phaseGoal, setPhaseGoal] = useState("");
  const [createPhase, setCreatePhase] = useState(true);
  const [review, setReview] = useState<ReviewIssue[] | null>(null);
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data: accounts = [] } = useQuery<GitHubAccount[]>({
    queryKey: ["github-accounts"],
    queryFn: async () => {
      const res = await fetch("/api/github/accounts");
      if (!res.ok) throw new Error("Failed to load GitHub accounts");
      return res.json();
    },
    enabled: open,
  });

  const { data: repos = [], isLoading: reposLoading } = useQuery<GitHubRepo[]>({
    queryKey: ["github-repos", accountId],
    queryFn: async () => {
      const res = await fetch(`/api/github/accounts/${accountId}/repos`);
      if (!res.ok) throw new Error("Failed to load repos");
      return res.json();
    },
    enabled: !!accountId,
  });

  const { isLoading: issuesLoading } = useQuery<CachedIssue[]>({
    queryKey: ["github-issues", accountId, repoFullName, "all", ""],
    queryFn: async () => {
      const [owner, repo] = repoFullName.split("/");
      const params = new URLSearchParams({
        accountId,
        owner,
        repo,
        state: "all",
      });
      const res = await fetch(`/api/github/issues?${params}`);
      if (!res.ok) throw new Error("Failed to load issues");
      const issues: CachedIssue[] = await res.json();
      setReview(
        issues.map((i) => ({
          issueId: i.id,
          included: i.state === "open",
          title: i.title,
          description: i.body ?? "",
          status: i.state === "open" ? "backlog" : "done",
          state: i.state,
          issueNumber: i.issueNumber,
          url: i.url,
          milestone: i.milestone,
        }))
      );
      setPhaseName(repoFullName.split("/")[1] ?? repoFullName);
      return issues;
    },
    enabled: !!accountId && !!repoFullName,
  });

  const syncMutation = useMutation({
    mutationFn: async () => {
      const [owner, repo] = repoFullName.split("/");
      const res = await fetch(`/api/github/accounts/${accountId}/sync`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ owner, repo, state: "all" }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Sync failed");
      }
      return res.json() as Promise<{ synced: number; repo: string }>;
    },
    onSuccess: (data) => {
      // GitHub's open_issues_count includes pull requests; the sync filters
      // them out, so "0" on a busy repo deserves the explanation.
      toast({
        title:
          data.synced === 0
            ? `No issues found in ${data.repo}`
            : `Synced ${data.synced} issues from ${data.repo}`,
        description:
          data.synced === 0
            ? "Pull requests don't count — the repo may only have PRs."
            : undefined,
      });
      queryClient.invalidateQueries({
        queryKey: ["github-issues", accountId, repoFullName],
      });
    },
    onError: (err: Error) => {
      toast({ title: "Sync failed", description: err.message, variant: "destructive" });
    },
  });

  const patchIssue = (i: number, patch: Partial<ReviewIssue>) =>
    setReview((r) =>
      r ? r.map((t, idx) => (idx === i ? { ...t, ...patch } : t)) : r
    );

  const included = (review ?? []).filter((t) => t.included && t.title.trim());

  const importMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/projects/${projectId}/github-import`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          phases: [
            {
              name: phaseName.trim() || repoFullName || "Imported from GitHub",
              goal: phaseGoal,
              createPhase,
              features: included.map((t) => ({
                title: t.title.trim(),
                description: t.description,
                priority: "medium",
                status: t.status,
                issueId: t.issueId,
              })),
            },
          ],
        }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(
          typeof err.error === "string" ? err.error : "Import failed"
        );
      }
      return res.json() as Promise<{ featureCount: number }>;
    },
    onSuccess: (data) => {
      toast({
        title: `Imported ${data.featureCount} feature${data.featureCount === 1 ? "" : "s"} from GitHub`,
      });
      queryClient.invalidateQueries({ queryKey: ["features", projectId] });
      queryClient.invalidateQueries({ queryKey: ["dev-phases", projectId] });
      setOpen(false);
      setReview(null);
    },
    onError: (err: Error) => {
      toast({ title: "Import failed", description: err.message, variant: "destructive" });
    },
  });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      {controlledOpen === undefined && (
        <DialogTrigger nativeButton render={<Button variant="outline" size="sm" className="gap-1.5" />}>
          <GitBranch className="h-4 w-4" />
          Import from GitHub
        </DialogTrigger>
      )}
      <DialogContent className="sm:max-w-3xl max-h-[90vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <GitBranch className="h-5 w-5" />
            Import GitHub issues as features
          </DialogTitle>
          <DialogDescription>
            Pick a repository, choose which issues to import, and they become
            features — optionally grouped under a new phase named after the
            repo.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3 flex-1 min-h-0">
          <div className="flex gap-2 flex-wrap">
            <Select
              value={accountId}
              onValueChange={(v) => {
                setAccountId(v ?? "");
                setRepoFullName("");
                setReview(null);
              }}
            >
              <SelectTrigger className="w-44">
                <SelectValue placeholder="Account">
                  {(v: unknown) =>
                    accounts.find((a) => a.id === v)?.label ?? String(v ?? "")
                  }
                </SelectValue>
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

            {/* Combobox, not a Select: accounts routinely have dozens of
                repos, so the picker needs type-to-filter. */}
            <Popover open={repoPickerOpen} onOpenChange={setRepoPickerOpen}>
              <PopoverTrigger
                nativeButton
                disabled={!accountId || reposLoading}
                render={
                  <Button
                    variant="outline"
                    size="sm"
                    className="flex-1 min-w-40 justify-between font-normal h-8"
                  />
                }
              >
                <span className={cn("truncate", !repoFullName && "text-muted-foreground")}>
                  {repoFullName ||
                    (reposLoading ? "Loading repos..." : "Repository")}
                </span>
                <ChevronsUpDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              </PopoverTrigger>
              <PopoverContent className="p-0 w-80" align="start">
                <Command>
                  <CommandInput placeholder="Search repositories..." />
                  <CommandList>
                    <CommandEmpty>No repository found.</CommandEmpty>
                    {repos.map((r) => (
                      <CommandItem
                        key={r.id}
                        value={r.full_name}
                        onSelect={(value) => {
                          setRepoFullName(value);
                          setRepoPickerOpen(false);
                        }}
                      >
                        <Check
                          className={cn(
                            "h-3.5 w-3.5",
                            repoFullName === r.full_name
                              ? "opacity-100"
                              : "opacity-0"
                          )}
                        />
                        <span className="truncate flex-1">{r.full_name}</span>
                        {r.open_issues_count > 0 && (
                          <span className="text-muted-foreground text-xs shrink-0">
                            {r.open_issues_count}
                          </span>
                        )}
                      </CommandItem>
                    ))}
                  </CommandList>
                </Command>
              </PopoverContent>
            </Popover>

            {repoFullName && (
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

          {!accountId ? (
            <div className="py-12 text-center text-sm text-muted-foreground border rounded-md">
              <GitBranch className="h-8 w-8 mx-auto mb-2 opacity-40" />
              Select a GitHub account to get started.
              <br />
              <a
                href="/settings?tab=integrations"
                className="text-primary hover:underline mt-1 inline-block"
              >
                Add an account in Settings →
              </a>
            </div>
          ) : !repoFullName ? (
            <div className="py-12 text-center text-sm text-muted-foreground border rounded-md">
              Pick a repository to load its issues.
            </div>
          ) : issuesLoading ? (
            <div className="py-12 flex items-center justify-center gap-2 text-sm text-muted-foreground border rounded-md">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading issues...
            </div>
          ) : !review || review.length === 0 ? (
            <div className="py-12 text-center text-sm text-muted-foreground border rounded-md">
              No cached issues for this repository yet.
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
            <>
              <div className="rounded-lg border p-3 space-y-2">
                <div className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={createPhase}
                    onChange={(e) => setCreatePhase(e.target.checked)}
                    className="h-3.5 w-3.5 accent-primary"
                    title="Group imported features under a new phase"
                  />
                  <Input
                    value={phaseName}
                    onChange={(e) => setPhaseName(e.target.value)}
                    placeholder="Phase name"
                    className="h-7 flex-1 text-sm font-medium"
                    disabled={!createPhase}
                  />
                  <span className="font-mono text-[10px] text-muted-foreground">
                    {included.length}/{review.length} issues
                  </span>
                </div>
                {createPhase ? (
                  <Textarea
                    value={phaseGoal}
                    onChange={(e) => setPhaseGoal(e.target.value)}
                    rows={1}
                    placeholder="Phase goal (optional)"
                    className="text-xs"
                  />
                ) : (
                  <p className="text-xs text-muted-foreground">
                    Features will be imported without a phase.
                  </p>
                )}
              </div>

              {/* Native overflow, not ScrollArea — see clickup-import-dialog. */}
              <div className="flex-1 min-h-0 overflow-y-auto border rounded-md">
                <div className="divide-y">
                  {review.map((issue, i) => (
                    <div
                      key={issue.issueId}
                      className={cn(
                        "flex items-center gap-2.5 px-3 py-2",
                        !issue.included && "opacity-50"
                      )}
                    >
                      <input
                        type="checkbox"
                        checked={issue.included}
                        onChange={(e) => patchIssue(i, { included: e.target.checked })}
                        className="h-3.5 w-3.5 shrink-0 accent-primary"
                        title="Import this issue"
                      />
                      {issue.state === "open" ? (
                        <CircleDot className="h-3.5 w-3.5 text-green-500 shrink-0" />
                      ) : (
                        <CircleCheck className="h-3.5 w-3.5 text-purple-500 shrink-0" />
                      )}
                      <span className="text-xs text-muted-foreground shrink-0">
                        #{issue.issueNumber}
                      </span>
                      <Input
                        value={issue.title}
                        onChange={(e) => patchIssue(i, { title: e.target.value })}
                        className="h-7 flex-1 text-xs"
                        disabled={!issue.included}
                      />
                      {issue.milestone && (
                        <Badge variant="outline" className="text-xs py-0 shrink-0">
                          {issue.milestone}
                        </Badge>
                      )}
                      <Badge variant="secondary" className="text-xs py-0 shrink-0">
                        → {issue.status}
                      </Badge>
                      <a
                        href={issue.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="shrink-0 text-muted-foreground hover:text-foreground"
                      >
                        <ExternalLink className="h-3.5 w-3.5" />
                      </a>
                    </div>
                  ))}
                </div>
              </div>
            </>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button
            onClick={() => importMutation.mutate()}
            disabled={included.length === 0 || importMutation.isPending}
          >
            {importMutation.isPending && (
              <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />
            )}
            Import {included.length > 0 ? `${included.length} ` : ""}as features
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
