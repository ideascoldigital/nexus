"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { BrandIcon } from "@/components/ui/brand-icon";
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
import { ExternalLink, Link as LinkIcon, Loader2, RefreshCw } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import {
  importPrompt,
  selectionGroupsOf,
  shouldShowProjectPath,
} from "@/lib/gitlab-import-review";
import {
  type CachedGitLabEpic,
  type CachedGitLabIssue,
  type GitLabGroupSummary,
  type GitLabProjectSummary,
  type GitLabScope,
  GitLabAccountSelect,
  GitLabEpicPicker,
  GitLabGroupPicker,
  GitLabProjectPicker,
  GitLabStateIcon,
  NoGitLabServer,
  useGitLabAccounts,
} from "./gitlab-shared";

interface ReviewIssue {
  issueId: string;
  included: boolean;
  title: string;
  description: string;
  status: string;
  state: string;
  issueIid: number;
  projectPath: string;
  url: string;
  milestone: string | null;
  epicIid: number | null;
  epicTitle: string | null;
  /** The board column this issue sat in, when it came from one. */
  boardStatus: string | null;
}

/** The last path segment — the project or group name, without its prefix. */
function lastSegment(path: string): string {
  return path.split("/").pop() || path;
}

/** The current scope resolved: how to query it, and what to call the phase. */
interface ScopeTarget {
  /** Query string that scopes `/api/gitlab/issues` to this selection. */
  params: Record<string, string>;
  phase: string;
  goal: string;
  label: string;
}

/** What `/resolve` hands back for a pasted URL. */
interface ResolvedUrl {
  label: string;
  origin: string;
  ref: Record<string, unknown> & { kind: string };
  board?: {
    id: number;
    name: string;
    ownerPath: string;
    owner: "group" | "project";
    milestoneTitle: string | null;
    columns: { title: string; listType: string; position: number | null }[];
  };
}

const SCOPE_LABEL: Record<GitLabScope, string> = {
  project: "Project",
  group: "Group",
  epic: "Epic",
};

export function GitLabImportDialog({
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
  const [scope, setScope] = useState<GitLabScope>("project");
  const [project, setProject] = useState<GitLabProjectSummary | null>(null);
  const [group, setGroup] = useState<GitLabGroupSummary | null>(null);
  const [epic, setEpic] = useState<CachedGitLabEpic | null>(null);
  const [phaseName, setPhaseName] = useState("");
  const [phaseGoal, setPhaseGoal] = useState("");
  const [createPhase, setCreatePhase] = useState(true);
  const [review, setReview] = useState<ReviewIssue[] | null>(null);
  const [urlInput, setUrlInput] = useState("");
  const [resolved, setResolved] = useState<ResolvedUrl | null>(null);
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data: accounts = [] } = useGitLabAccounts(open);

  /**
   * A resolved URL wins over the pickers.
   *
   * A board is nothing but "this owner's issues, narrowed to a milestone", so
   * it needs no scope of its own on the read side — the phase is named after
   * the milestone when there is one, since that is the slice being imported,
   * and after the board otherwise.
   */
  const resolvedTarget = ((): ScopeTarget | null => {
    if (!resolved) return null;
    const ref = resolved.ref;
    if (resolved.board) {
      const b = resolved.board;
      const milestone =
        (ref.milestoneTitle as string | null) ?? b.milestoneTitle;
      return {
        params: {
          ...(b.owner === "group"
            ? { groupPath: b.ownerPath }
            : { projectPath: b.ownerPath }),
          ...(milestone ? { milestone } : {}),
        },
        phase: milestone ?? b.name,
        goal: milestone ? `From the "${b.name}" board.` : "",
        label: resolved.label,
      };
    }
    if (ref.kind === "group") {
      return {
        params: { groupPath: String(ref.groupPath) },
        phase: lastSegment(String(ref.groupPath)),
        goal: "",
        label: resolved.label,
      };
    }
    if (ref.kind === "project") {
      return {
        params: { projectPath: String(ref.projectPath) },
        phase: lastSegment(String(ref.projectPath)),
        goal: "",
        label: resolved.label,
      };
    }
    if (ref.kind === "milestone") {
      return {
        params: {
          ...(ref.owner === "group"
            ? { groupPath: String(ref.ownerPath) }
            : { projectPath: String(ref.ownerPath) }),
          milestone: String(ref.milestoneTitle),
        },
        phase: String(ref.milestoneTitle),
        goal: "",
        label: resolved.label,
      };
    }
    return null;
  })();

  /** Whatever the current scope resolves to: what to fetch, and what to call it. */
  const pickedTarget = ((): ScopeTarget | null => {
    if (scope === "project" && project)
      return {
        params: { projectId: String(project.id) },
        phase: lastSegment(project.path_with_namespace),
        goal: "",
        label: project.path_with_namespace,
      };
    if (scope === "group" && group)
      return {
        params: { groupPath: group.full_path },
        phase: lastSegment(group.full_path),
        goal: "",
        label: group.full_path,
      };
    if (scope === "epic" && epic)
      return {
        params: { epicId: String(epic.epicId) },
        // An epic is already a titled, described body of work — which is what a
        // dev phase is. Its description becomes the phase goal verbatim.
        phase: epic.title,
        goal: epic.body ?? "",
        label: `&${epic.epicIid} ${epic.title}`,
      };
    return null;
  })();

  const target = resolvedTarget ?? pickedTarget;

  const resetScope = () => {
    setProject(null);
    setGroup(null);
    setEpic(null);
    setReview(null);
    setResolved(null);
  };

  /**
   * Paste a URL, get the work. Resolving and syncing are one action because
   * "here is the thing I am looking at" should not then require choosing a
   * scope and pressing sync — the URL already said both.
   */
  const resolveMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(
        `/api/gitlab/accounts/${accountId}/resolve?url=${encodeURIComponent(urlInput.trim())}`,
      );
      const body = await res.json();
      if (!res.ok) {
        throw new Error(
          typeof body.error === "string" ? body.error : "Could not read that URL",
        );
      }
      const found = body as ResolvedUrl;

      const ref = found.ref;
      const sync = found.board
        ? {
            mode: "board",
            ownerPath: found.board.ownerPath,
            owner: found.board.owner,
            boardId: found.board.id,
            milestoneTitle:
              (ref.milestoneTitle as string | null) ?? found.board.milestoneTitle,
          }
        : ref.kind === "group" || ref.kind === "milestone"
          ? {
              mode: "group",
              groupId: String(ref.groupPath ?? ref.ownerPath),
              groupPath: String(ref.groupPath ?? ref.ownerPath),
              state: "all",
            }
          : null;

      if (sync) {
        const syncRes = await fetch(
          `/api/gitlab/accounts/${accountId}/sync`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(sync),
          },
        );
        if (!syncRes.ok) {
          const err = await syncRes.json();
          throw new Error(err.error || "Sync failed");
        }
        return { found, synced: (await syncRes.json()).synced as number };
      }
      return { found, synced: null };
    },
    onSuccess: ({ found, synced }) => {
      // A pasted URL from another instance would silently import nothing.
      const serverOrigin = accounts.find((a) => a.id === accountId)?.metadata
        ?.baseUrl;
      if (serverOrigin && !serverOrigin.startsWith(found.origin)) {
        toast({
          title: "That URL is on another instance",
          description: `The selected server is ${serverOrigin}, but the URL points at ${found.origin}.`,
          variant: "destructive",
        });
        return;
      }
      setResolved(found);
      setReview(null);
      toast({
        title: `Found ${found.label}`,
        description:
          synced === null
            ? "Sync it below to load its issues."
            : `Synced ${synced} issues.`,
      });
      queryClient.invalidateQueries({ queryKey: ["gitlab-issues", accountId] });
    },
    onError: (err: Error) => {
      toast({
        title: "Could not read that URL",
        description: err.message,
        variant: "destructive",
      });
    },
  });

  const { isLoading: issuesLoading } = useQuery<CachedGitLabIssue[]>({
    queryKey: ["gitlab-issues", accountId, target?.params, "all"],
    queryFn: async () => {
      const params = new URLSearchParams({
        accountId,
        state: "all",
        ...target!.params,
      });
      const res = await fetch(`/api/gitlab/issues?${params}`);
      if (!res.ok) throw new Error("Failed to load issues");
      const issues: CachedGitLabIssue[] = await res.json();
      setReview(
        issues.map((i) => ({
          issueId: i.id,
          // Closed issues are history, not backlog — imported only on purpose.
          included: i.state === "opened",
          title: i.title,
          description: i.body ?? "",
          // The server already decided this: a board column when the issue came
          // from one, plain open/closed otherwise.
          status: i.suggestedStatus ?? (i.state === "opened" ? "backlog" : "done"),
          boardStatus: i.boardStatus ?? null,
          state: i.state,
          issueIid: i.issueIid,
          projectPath: i.projectPath,
          url: i.url,
          milestone: i.milestone,
          epicIid: i.epicIid ?? null,
          epicTitle: i.epicTitle ?? null,
        })),
      );
      setPhaseName(target!.phase);
      setPhaseGoal(target!.goal);
      return issues;
    },
    enabled: !!accountId && !!target,
  });

  const syncMutation = useMutation({
    mutationFn: async () => {
      // Epics are cached in two steps: the epic rows for the group, then the
      // issues under whichever epic is selected. Before one is picked, syncing
      // means "fill the epic picker".
      const body =
        scope === "project"
          ? {
              mode: "project",
              projectId: project!.id,
              projectPath: project!.path_with_namespace,
              state: "all",
            }
          : scope === "group"
            ? {
                mode: "group",
                groupId: group!.id,
                groupPath: group!.full_path,
                state: "all",
              }
            : epic
              ? {
                  mode: "epic-issues",
                  groupId: epic.groupId,
                  epicIid: epic.epicIid,
                }
              : {
                  mode: "epics",
                  groupId: group!.id,
                  groupPath: group!.full_path,
                  state: "all",
                };

      const res = await fetch(`/api/gitlab/accounts/${accountId}/sync`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Sync failed");
      }
      return {
        ...(await res.json()),
        synced_epics: body.mode === "epics",
      } as {
        synced: number;
        truncated?: boolean;
        synced_epics: boolean;
      };
    },
    onSuccess: (data) => {
      toast({
        title: data.synced_epics
          ? `Synced ${data.synced} epics from ${group?.full_path}`
          : data.synced === 0
            ? `No issues found in ${target?.label ?? "that scope"}`
            : `Synced ${data.synced} issues`,
        description: data.truncated
          ? "Stopped at 1000 issues — pick a subgroup or a project to narrow it down."
          : undefined,
      });
      queryClient.invalidateQueries({ queryKey: ["gitlab-epics", accountId] });
      queryClient.invalidateQueries({ queryKey: ["gitlab-issues", accountId] });
    },
    onError: (err: Error) => {
      toast({
        title: "Sync failed",
        description: err.message,
        variant: "destructive",
      });
    },
  });

  const patchIssue = (i: number, patch: Partial<ReviewIssue>) =>
    setReview((r) =>
      r ? r.map((t, idx) => (idx === i ? { ...t, ...patch } : t)) : r,
    );

  const included = (review ?? []).filter((t) => t.included && t.title.trim());
  const showProjectPath = shouldShowProjectPath(review ?? []);
  const selectionGroups = selectionGroupsOf(
    review ?? [],
    resolved?.board?.columns.map((c) => c.title) ?? [],
  );
  const allIndices = (review ?? []).map((_, i) => i);

  const setIncluded = (indices: number[], included: boolean) => {
    const target = new Set(indices);
    setReview((r) =>
      r ? r.map((t, i) => (target.has(i) ? { ...t, included } : t)) : r,
    );
  };

  const importMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/projects/${projectId}/gitlab-import`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          phases: [
            {
              name: phaseName.trim() || target?.label || "Imported from GitLab",
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
          typeof err.error === "string" ? err.error : "Import failed",
        );
      }
      return res.json() as Promise<{ featureCount: number }>;
    },
    onSuccess: (data) => {
      toast({
        title: `Imported ${data.featureCount} feature${data.featureCount === 1 ? "" : "s"} from GitLab`,
      });
      queryClient.invalidateQueries({ queryKey: ["features", projectId] });
      queryClient.invalidateQueries({ queryKey: ["dev-phases", projectId] });
      setOpen(false);
      setReview(null);
    },
    onError: (err: Error) => {
      toast({
        title: "Import failed",
        description: err.message,
        variant: "destructive",
      });
    },
  });

  /** The empty state between picking a server and having something to review. */
  const prompt = importPrompt({
    accountId,
    hasResolvedUrl: !!resolved,
    scope,
    hasProject: !!project,
    hasGroup: !!group,
    hasEpic: !!epic,
  });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      {controlledOpen === undefined && (
        <DialogTrigger
          nativeButton
          render={<Button variant="outline" size="sm" className="gap-1.5" />}
        >
          <BrandIcon brand="gitlab" className="h-4 w-4" />
          Import from GitLab
        </DialogTrigger>
      )}
      <DialogContent className="sm:max-w-3xl max-h-[90vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <BrandIcon brand="gitlab" className="h-5 w-5" />
            Import GitLab issues as features
          </DialogTitle>
          <DialogDescription>
            Scope by project, by group (subgroups included), or by epic — an
            epic already is a titled body of work spanning repos, so it becomes
            the phase and its issues become the features.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3 flex-1 min-h-0">
          {/* The address bar already names the slice of work — a board, a
              board filtered by milestone, an epic. Retyping that as a scope
              plus a filter is re-deriving what you are looking at. */}
          <div className="flex gap-2">
            <Input
              value={urlInput}
              onChange={(e) => setUrlInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && urlInput.trim() && accountId) {
                  e.preventDefault();
                  resolveMutation.mutate();
                }
              }}
              placeholder="Paste a GitLab URL — a board, an epic, a group…"
              className="h-8 flex-1 text-xs font-mono"
              disabled={!accountId}
            />
            <Button
              variant="outline"
              size="sm"
              className="h-8"
              onClick={() => resolveMutation.mutate()}
              disabled={!accountId || !urlInput.trim() || resolveMutation.isPending}
            >
              {resolveMutation.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                "Open"
              )}
            </Button>
          </div>

          {resolved && (
            <div className="flex items-center gap-2 rounded-md border border-primary/40 bg-primary/5 px-3 py-1.5">
              <LinkIcon className="h-3.5 w-3.5 shrink-0 text-primary" />
              <span className="text-xs flex-1 truncate">{resolved.label}</span>
              {resolved.board?.columns.length ? (
                <span className="text-[10px] text-muted-foreground shrink-0">
                  {resolved.board.columns.length} columns
                </span>
              ) : null}
              <button
                onClick={() => {
                  setResolved(null);
                  setUrlInput("");
                  setReview(null);
                }}
                className="text-[10px] text-muted-foreground hover:text-foreground shrink-0"
              >
                clear
              </button>
            </div>
          )}

          <div
            className={cn(
              "flex gap-2 flex-wrap",
              // The pickers are the other way in; a resolved URL has already
              // answered what they ask, so they only add noise.
              resolved && "opacity-40 pointer-events-none",
            )}
          >
            <GitLabAccountSelect
              accounts={accounts}
              value={accountId}
              onChange={(v) => {
                setAccountId(v);
                resetScope();
              }}
            />

            <Select
              value={scope}
              onValueChange={(v) => {
                if (!v) return;
                setScope(v as GitLabScope);
                resetScope();
              }}
            >
              <SelectTrigger className="w-28">
                <SelectValue>
                  {(v: unknown) => SCOPE_LABEL[v as GitLabScope] ?? String(v)}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="project">Project</SelectItem>
                <SelectItem value="group">Group</SelectItem>
                <SelectItem value="epic">Epic</SelectItem>
              </SelectContent>
            </Select>

            {scope === "project" ? (
              <GitLabProjectPicker
                accountId={accountId}
                value={project}
                onChange={(p) => {
                  setProject(p);
                  setReview(null);
                }}
              />
            ) : (
              <GitLabGroupPicker
                accountId={accountId}
                value={group}
                onChange={(g) => {
                  setGroup(g);
                  setEpic(null);
                  setReview(null);
                }}
              />
            )}

            {scope === "epic" && (
              <GitLabEpicPicker
                accountId={accountId}
                group={group}
                value={epic}
                onChange={(e) => {
                  setEpic(e);
                  setReview(null);
                }}
              />
            )}

            {(project || group) && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => syncMutation.mutate()}
                disabled={syncMutation.isPending}
                title={
                  scope === "epic" && !epic
                    ? "Sync this group's epics from GitLab"
                    : "Sync issues from GitLab"
                }
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
            <NoGitLabServer action="get started" />
          ) : prompt ? (
            <div className="py-12 text-center text-sm text-muted-foreground border rounded-md">
              {prompt}
              {scope === "epic" && group && !epic && (
                <>
                  <br />
                  <button
                    onClick={() => syncMutation.mutate()}
                    className="text-primary hover:underline mt-1"
                    disabled={syncMutation.isPending}
                  >
                    Sync epics from GitLab →
                  </button>
                </>
              )}
            </div>
          ) : issuesLoading ? (
            <div className="py-12 flex items-center justify-center gap-2 text-sm text-muted-foreground border rounded-md">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading issues...
            </div>
          ) : !review || review.length === 0 ? (
            <div className="py-12 text-center text-sm text-muted-foreground border rounded-md">
              No cached issues for {target?.label ?? "this scope"} yet.
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

              {selectionGroups.length > 0 && (
                <div className="flex items-center gap-1.5 flex-wrap">
                  <span className="text-[10px] text-muted-foreground mr-0.5">
                    Select
                  </span>
                  <button
                    onClick={() => setIncluded(allIndices, true)}
                    className="rounded border px-1.5 py-0.5 text-[10px] hover:bg-muted"
                  >
                    all
                  </button>
                  <button
                    onClick={() => setIncluded(allIndices, false)}
                    className="rounded border px-1.5 py-0.5 text-[10px] hover:bg-muted"
                  >
                    none
                  </button>
                  <span className="text-muted-foreground/40 text-[10px]">|</span>
                  {selectionGroups.map((g) => {
                    const all = g.chosen === g.indices.length;
                    const some = g.chosen > 0 && !all;
                    return (
                      <button
                        key={g.label}
                        // Clicking a partly-chosen group completes it rather
                        // than clearing it — the click means "I want these".
                        onClick={() => setIncluded(g.indices, !all)}
                        title={`${all ? "Deselect" : "Select"} the ${g.indices.length} issue${g.indices.length === 1 ? "" : "s"} in "${g.label}"`}
                        className={cn(
                          "rounded border px-1.5 py-0.5 text-[10px] transition-colors",
                          all && "border-primary/60 bg-primary/10 text-foreground",
                          some && "border-primary/40 bg-primary/5",
                          !all && !some && "text-muted-foreground hover:bg-muted",
                        )}
                      >
                        {g.label}
                        <span className="ml-1 font-mono opacity-70">
                          {g.chosen}/{g.indices.length}
                        </span>
                      </button>
                    );
                  })}
                </div>
              )}

              {/* Native overflow, not ScrollArea — see clickup-import-dialog. */}
              <div className="flex-1 min-h-0 overflow-y-auto border rounded-md">
                <div className="divide-y">
                  {review.map((issue, i) => (
                    <div
                      key={issue.issueId}
                      className={cn(
                        "flex items-center gap-2.5 px-3 py-2",
                        !issue.included && "opacity-50",
                      )}
                    >
                      <input
                        type="checkbox"
                        checked={issue.included}
                        onChange={(e) =>
                          patchIssue(i, { included: e.target.checked })
                        }
                        className="h-3.5 w-3.5 shrink-0 accent-primary"
                        title="Import this issue"
                      />
                      <GitLabStateIcon state={issue.state} />
                      <span className="text-xs text-muted-foreground shrink-0">
                        {showProjectPath && (
                          <span className="opacity-70">
                            {lastSegment(issue.projectPath)}
                          </span>
                        )}
                        #{issue.issueIid}
                      </span>
                      <Input
                        value={issue.title}
                        onChange={(e) =>
                          patchIssue(i, { title: e.target.value })
                        }
                        className="h-7 flex-1 text-xs"
                        disabled={!issue.included}
                      />
                      {/* The board column it sat in, next to where it lands —
                          the mapping is a heuristic over free-form names, so
                          showing both is what makes it checkable. */}
                      {issue.boardStatus && (
                        <Badge
                          variant="outline"
                          className="text-xs py-0 shrink-0 max-w-32 truncate"
                        >
                          {issue.boardStatus}
                        </Badge>
                      )}
                      {/* Only outside epic scope: under an epic every row would
                          carry the same badge, which says nothing. */}
                      {!resolved && scope !== "epic" && issue.epicIid && (
                        <Badge
                          variant="outline"
                          className="text-xs py-0 shrink-0 max-w-32 truncate"
                          title={issue.epicTitle ?? undefined}
                        >
                          &amp;{issue.epicIid}
                        </Badge>
                      )}
                      {issue.milestone && (
                        <Badge
                          variant="outline"
                          className="text-xs py-0 shrink-0"
                        >
                          {issue.milestone}
                        </Badge>
                      )}
                      <Badge
                        variant="secondary"
                        className="text-xs py-0 shrink-0"
                      >
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
