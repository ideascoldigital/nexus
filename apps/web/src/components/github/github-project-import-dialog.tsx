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
  ExternalLink,
  KanbanSquare,
  Loader2,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";

interface GitHubAccount {
  id: string;
  label: string;
  metadata: { login: string } | null;
}

interface ProjectSummary {
  id: string;
  title: string;
  number: number;
  owner: string;
}

interface ProjectList {
  projects: ProjectSummary[];
  warning: string | null;
}

interface ProjectItem {
  itemId: string;
  type: "ISSUE" | "DRAFT_ISSUE";
  title: string;
  body: string | null;
  statusColumn: string | null;
  iteration: string | null;
  priority: string | null;
  issue: { id: string; number: number; url: string; repo: string } | null;
}

// Mirrors mapColumnToStatus/mapProjectPriority server-side — duplicated here
// so the review can show the mapping before anything is sent.
function mapColumn(column: string | null): string {
  const c = (column ?? "").toLowerCase();
  if (/progress|doing/.test(c)) return "in_progress";
  if (/review/.test(c)) return "in_review";
  if (/done|complete|closed|shipped/.test(c)) return "done";
  if (/todo|to do|ready|next/.test(c)) return "todo";
  return "backlog";
}

function mapPriority(priority: string | null): string {
  const p = (priority ?? "").toLowerCase();
  if (/urgent|critical|p0/.test(p)) return "urgent";
  if (/high|p1/.test(p)) return "high";
  if (/low|p3|p4/.test(p)) return "low";
  return "medium";
}

interface ReviewItem {
  included: boolean;
  title: string;
  description: string;
  status: string;
  statusColumn: string | null;
  priority: string;
  issueId: string | null;
  issueNumber: number | null;
  url: string | null;
}

interface ReviewGroup {
  iteration: string | null;
  name: string;
  createPhase: boolean;
  items: ReviewItem[];
}

function toReview(items: ProjectItem[]): ReviewGroup[] {
  const groups = new Map<string | null, ReviewItem[]>();
  for (const item of items) {
    const status = mapColumn(item.statusColumn);
    const review: ReviewItem = {
      included: status !== "done",
      title: item.title,
      description: item.body ?? "",
      status,
      statusColumn: item.statusColumn,
      priority: mapPriority(item.priority),
      issueId: item.issue?.id ?? null,
      issueNumber: item.issue?.number ?? null,
      url: item.issue?.url ?? null,
    };
    const key = item.iteration;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(review);
  }
  // Iterations first (board order), the iteration-less bucket last and
  // phaseless by default.
  const result: ReviewGroup[] = [];
  for (const [iteration, groupItems] of groups) {
    if (iteration !== null) {
      result.push({ iteration, name: iteration, createPhase: true, items: groupItems });
    }
  }
  const loose = groups.get(null);
  if (loose) {
    result.push({
      iteration: null,
      name: "No iteration",
      createPhase: false,
      items: loose,
    });
  }
  return result;
}

export function GitHubProjectImportDialog({
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
  const [ghProject, setGhProject] = useState<ProjectSummary | null>(null);
  const [projectPickerOpen, setProjectPickerOpen] = useState(false);
  const [projectUrl, setProjectUrl] = useState("");
  const [extraProjects, setExtraProjects] = useState<ProjectSummary[]>([]);
  const [review, setReview] = useState<ReviewGroup[] | null>(null);
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

  const { data: projectList, isLoading: projectsLoading } = useQuery<ProjectList>({
    queryKey: ["github-projects", accountId],
    queryFn: async () => {
      const res = await fetch(`/api/github/accounts/${accountId}/projects`);
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Failed to load GitHub projects");
      }
      return res.json();
    },
    enabled: !!accountId,
  });
  const listed = projectList?.projects ?? [];
  // Boards resolved by URL live alongside the listed ones until reload.
  const projects = [
    ...listed,
    ...extraProjects.filter((e) => !listed.some((p) => p.id === e.id)),
  ];

  // A board nobody can list — another user's, or an org whose membership is
  // private — is still importable if you can paste its URL.
  const resolveMutation = useMutation({
    mutationFn: async (url: string) => {
      const res = await fetch(
        `/api/github/accounts/${accountId}/projects?url=${encodeURIComponent(url)}`
      );
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not resolve that board");
      return (data as ProjectList).projects[0];
    },
    onSuccess: (project) => {
      setExtraProjects((prev) =>
        prev.some((p) => p.id === project.id) ? prev : [...prev, project]
      );
      setGhProject(project);
      setProjectUrl("");
      setProjectPickerOpen(false);
    },
    onError: (err: Error) =>
      toast({ title: "Board not found", description: err.message, variant: "destructive" }),
  });

  const { isLoading: itemsLoading, error: itemsError } = useQuery({
    queryKey: ["github-project-items", accountId, ghProject?.id],
    queryFn: async () => {
      const res = await fetch(
        `/api/github/accounts/${accountId}/projects/items?ghProjectId=${encodeURIComponent(ghProject!.id)}`
      );
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Failed to load project items");
      }
      const data: { title: string; items: ProjectItem[] } = await res.json();
      setReview(toReview(data.items));
      return data;
    },
    enabled: !!accountId && !!ghProject,
    retry: false,
  });

  const patchGroup = (g: number, patch: Partial<ReviewGroup>) =>
    setReview((r) =>
      r ? r.map((grp, i) => (i === g ? { ...grp, ...patch } : grp)) : r
    );
  const patchItem = (g: number, idx: number, patch: Partial<ReviewItem>) =>
    setReview((r) =>
      r
        ? r.map((grp, i) =>
            i === g
              ? {
                  ...grp,
                  items: grp.items.map((it, j) =>
                    j === idx ? { ...it, ...patch } : it
                  ),
                }
              : grp
          )
        : r
    );

  const includedCount = (review ?? []).reduce(
    (acc, g) => acc + g.items.filter((i) => i.included && i.title.trim()).length,
    0
  );
  const totalCount = (review ?? []).reduce((acc, g) => acc + g.items.length, 0);

  const importMutation = useMutation({
    mutationFn: async () => {
      const phases = (review ?? [])
        .map((g) => ({
          name: g.name.trim() || "Imported from GitHub Project",
          goal: "",
          createPhase: g.createPhase,
          features: g.items
            .filter((i) => i.included && i.title.trim())
            .map((i) => ({
              title: i.title.trim(),
              description: i.description,
              priority: i.priority,
              status: i.status,
              issueId: i.issueId,
            })),
        }))
        .filter((p) => p.features.length > 0);

      const res = await fetch(`/api/projects/${projectId}/github-import`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phases }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(typeof err.error === "string" ? err.error : "Import failed");
      }
      const created = (await res.json()) as { featureCount: number };

      // Remember the board so "Sync GitHub Project" can update these
      // features when columns/iterations change upstream.
      await fetch(`/api/projects/${projectId}/github-project-link`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          accountId,
          ghProjectId: ghProject!.id,
          title: ghProject!.title,
        }),
      });

      return created;
    },
    onSuccess: (data) => {
      toast({
        title: `Imported ${data.featureCount} feature${data.featureCount === 1 ? "" : "s"} from the GitHub project`,
      });
      queryClient.invalidateQueries({ queryKey: ["features", projectId] });
      queryClient.invalidateQueries({ queryKey: ["dev-phases", projectId] });
      queryClient.invalidateQueries({ queryKey: ["github-project-link", projectId] });
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
          <KanbanSquare className="h-4 w-4" />
          Import GitHub Project
        </DialogTrigger>
      )}
      <DialogContent className="sm:max-w-3xl max-h-[90vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <KanbanSquare className="h-5 w-5" />
            Import a GitHub Project board
          </DialogTitle>
          <DialogDescription>
            Iterations become phases, board columns become kanban status, and
            each item is yours to include or skip. The board stays linked for
            later re-sync.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3 flex-1 min-h-0">
          <div className="flex gap-2 flex-wrap">
            <Select
              value={accountId}
              onValueChange={(v) => {
                setAccountId(v ?? "");
                setGhProject(null);
                setExtraProjects([]);
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

            <Popover open={projectPickerOpen} onOpenChange={setProjectPickerOpen}>
              <PopoverTrigger
                nativeButton
                disabled={!accountId || projectsLoading}
                render={
                  <Button
                    variant="outline"
                    size="sm"
                    className="flex-1 min-w-40 justify-between font-normal h-8"
                  />
                }
              >
                <span className={cn("truncate", !ghProject && "text-muted-foreground")}>
                  {ghProject
                    ? `${ghProject.owner} / ${ghProject.title}`
                    : projectsLoading
                      ? "Loading projects..."
                      : "GitHub project"}
                </span>
                <ChevronsUpDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              </PopoverTrigger>
              <PopoverContent className="p-0 w-96" align="start">
                <Command>
                  <CommandInput placeholder="Search projects..." />
                  <CommandList>
                    <CommandEmpty>No project found.</CommandEmpty>
                    {projects.map((p) => (
                      <CommandItem
                        key={p.id}
                        value={`${p.owner}/${p.title} #${p.number}`}
                        onSelect={() => {
                          setGhProject(p);
                          setProjectPickerOpen(false);
                        }}
                      >
                        <Check
                          className={cn(
                            "h-3.5 w-3.5",
                            ghProject?.id === p.id ? "opacity-100" : "opacity-0"
                          )}
                        />
                        <span className="truncate flex-1">
                          {p.owner} / {p.title}
                        </span>
                        <span className="text-muted-foreground text-xs shrink-0">
                          #{p.number}
                        </span>
                      </CommandItem>
                    ))}
                  </CommandList>
                </Command>
                <div className="border-t p-2 space-y-1.5">
                  <p className="text-[11px] text-muted-foreground">
                    Board not listed? Paste its URL — works for other people&apos;s
                    and private-membership org boards.
                  </p>
                  <div className="flex gap-1.5">
                    <Input
                      value={projectUrl}
                      onChange={(e) => setProjectUrl(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && projectUrl.trim()) {
                          e.preventDefault();
                          resolveMutation.mutate(projectUrl.trim());
                        }
                      }}
                      placeholder="https://github.com/orgs/acme/projects/3"
                      className="h-7 text-xs"
                    />
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 px-2 text-xs shrink-0"
                      disabled={!projectUrl.trim() || resolveMutation.isPending}
                      onClick={() => resolveMutation.mutate(projectUrl.trim())}
                    >
                      {resolveMutation.isPending ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        "Load"
                      )}
                    </Button>
                  </div>
                </div>
              </PopoverContent>
            </Popover>
          </div>

          {projectList?.warning && (
            <p className="text-xs text-amber-600 dark:text-amber-500">
              {projectList.warning}
            </p>
          )}

          {!accountId ? (
            <div className="py-12 text-center text-sm text-muted-foreground border rounded-md">
              <KanbanSquare className="h-8 w-8 mx-auto mb-2 opacity-40" />
              Select a GitHub account to get started.
              <br />
              <a
                href="/settings?tab=integrations"
                className="text-primary hover:underline mt-1 inline-block"
              >
                Add an account in Settings →
              </a>
            </div>
          ) : !ghProject ? (
            <div className="py-12 text-center text-sm text-muted-foreground border rounded-md">
              Pick a GitHub project to load its board.
            </div>
          ) : itemsLoading ? (
            <div className="py-12 flex items-center justify-center gap-2 text-sm text-muted-foreground border rounded-md">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading board items...
            </div>
          ) : itemsError ? (
            <div className="py-12 text-center text-sm text-destructive border border-destructive/50 rounded-md px-4">
              {(itemsError as Error).message}
            </div>
          ) : !review || totalCount === 0 ? (
            <div className="py-12 text-center text-sm text-muted-foreground border rounded-md">
              This board has no importable items (pull requests are skipped).
            </div>
          ) : (
            <div className="flex-1 min-h-0 overflow-y-auto space-y-3 pr-1">
              {review.map((group, g) => (
                <div key={group.iteration ?? "__none"} className="rounded-lg border p-3 space-y-2">
                  <div className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={group.createPhase}
                      onChange={(e) => patchGroup(g, { createPhase: e.target.checked })}
                      className="h-3.5 w-3.5 accent-primary"
                      title="Create a phase for this iteration"
                    />
                    <Input
                      value={group.name}
                      onChange={(e) => patchGroup(g, { name: e.target.value })}
                      className="h-7 flex-1 text-sm font-medium"
                      disabled={!group.createPhase}
                    />
                    <span className="font-mono text-[10px] text-muted-foreground">
                      {group.items.filter((i) => i.included).length}/{group.items.length}
                    </span>
                  </div>
                  {!group.createPhase && (
                    <p className="text-xs text-muted-foreground">
                      These features will be imported without a phase.
                    </p>
                  )}
                  <div className="divide-y border rounded-md">
                    {group.items.map((item, idx) => (
                      <div
                        key={`${g}-${idx}`}
                        className={cn(
                          "flex items-center gap-2.5 px-3 py-2",
                          !item.included && "opacity-50"
                        )}
                      >
                        <input
                          type="checkbox"
                          checked={item.included}
                          onChange={(e) => patchItem(g, idx, { included: e.target.checked })}
                          className="h-3.5 w-3.5 shrink-0 accent-primary"
                          title="Import this item"
                        />
                        {item.issueNumber != null ? (
                          <span className="text-xs text-muted-foreground shrink-0">
                            #{item.issueNumber}
                          </span>
                        ) : (
                          <Badge variant="outline" className="text-xs py-0 shrink-0">
                            draft
                          </Badge>
                        )}
                        <Input
                          value={item.title}
                          onChange={(e) => patchItem(g, idx, { title: e.target.value })}
                          className="h-7 flex-1 text-xs"
                          disabled={!item.included}
                        />
                        {item.statusColumn && (
                          <Badge variant="outline" className="text-xs py-0 shrink-0">
                            {item.statusColumn}
                          </Badge>
                        )}
                        <Badge variant="secondary" className="text-xs py-0 shrink-0">
                          → {item.status}
                        </Badge>
                        {item.url && (
                          <a
                            href={item.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="shrink-0 text-muted-foreground hover:text-foreground"
                          >
                            <ExternalLink className="h-3.5 w-3.5" />
                          </a>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button
            onClick={() => importMutation.mutate()}
            disabled={includedCount === 0 || importMutation.isPending}
          >
            {importMutation.isPending && (
              <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />
            )}
            Import {includedCount > 0 ? `${includedCount} ` : ""}as features
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
