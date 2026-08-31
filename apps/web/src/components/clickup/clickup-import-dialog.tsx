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
import { CheckSquare, ExternalLink, Loader2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import {
  CachedClickUpTask,
  ClickUpBrowserSelects,
  TaskStateIcon,
  useClickUpBrowser,
} from "./clickup-task-picker";

// ClickUp statuses are free-form per list; the status *type* is the stable
// part. Closed work still imports (unchecked by default) as done.
function mapStatus(statusType: string | null): string {
  if (statusType === "done" || statusType === "closed") return "done";
  if (statusType === "custom") return "todo";
  return "backlog";
}

function mapPriority(priority: string | null): string {
  if (priority === "urgent" || priority === "high" || priority === "low") {
    return priority;
  }
  return "medium";
}

interface ReviewTask {
  clickUpTaskId: string;
  included: boolean;
  title: string;
  description: string;
  status: string;
  priority: string;
  url: string;
  clickUpStatus: string | null;
  statusType: string | null;
  isSubtask: boolean;
}

export function ClickUpImportDialog({
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
  const [phaseName, setPhaseName] = useState("");
  const [phaseGoal, setPhaseGoal] = useState("");
  const [createPhase, setCreatePhase] = useState(true);
  const [review, setReview] = useState<ReviewTask[] | null>(null);
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const browser = useClickUpBrowser(open);

  const selectedList = browser.lists.find((l) => l.id === browser.listId);

  const { isLoading: tasksLoading } = useQuery<CachedClickUpTask[]>({
    queryKey: ["clickup-tasks", browser.accountId, browser.listId, ""],
    queryFn: async () => {
      const params = new URLSearchParams({
        accountId: browser.accountId,
        listId: browser.listId,
        includeClosed: "true",
      });
      const res = await fetch(`/api/clickup/tasks?${params}`);
      if (!res.ok) throw new Error("Failed to load tasks");
      const tasks: CachedClickUpTask[] = await res.json();
      setReview(
        tasks.map((t) => ({
          clickUpTaskId: t.id,
          included: t.statusType !== "closed" && t.statusType !== "done",
          title: t.name,
          description: t.description ?? "",
          status: mapStatus(t.statusType),
          priority: mapPriority(t.priority),
          url: t.url,
          clickUpStatus: t.status,
          statusType: t.statusType,
          isSubtask: t.parentTaskId !== null,
        }))
      );
      setPhaseName(selectedList ? selectedList.name : "");
      return tasks;
    },
    enabled: !!browser.accountId && !!browser.listId,
  });

  const patchTask = (i: number, patch: Partial<ReviewTask>) =>
    setReview((r) =>
      r ? r.map((t, idx) => (idx === i ? { ...t, ...patch } : t)) : r
    );

  const included = (review ?? []).filter((t) => t.included && t.title.trim());

  const importMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/projects/${projectId}/clickup-import`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          phases: [
            {
              name: phaseName.trim() || selectedList?.name || "Imported from ClickUp",
              goal: phaseGoal,
              createPhase,
              features: included.map((t) => ({
                title: t.title.trim(),
                description: t.description,
                priority: t.priority,
                status: t.status,
                clickUpTaskId: t.clickUpTaskId,
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
        title: `Imported ${data.featureCount} feature${data.featureCount === 1 ? "" : "s"} from ClickUp`,
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
          <CheckSquare className="h-4 w-4" />
          Import from ClickUp
        </DialogTrigger>
      )}
      <DialogContent className="sm:max-w-3xl max-h-[90vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <CheckSquare className="h-5 w-5" />
            Import ClickUp tasks as features
          </DialogTitle>
          <DialogDescription>
            Pick a list, choose which tasks to import, and they become features
            — optionally grouped under a new phase named after the list.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3 flex-1 min-h-0">
          <ClickUpBrowserSelects browser={browser} />

          {!browser.accountId ? (
            <div className="py-12 text-center text-sm text-muted-foreground border rounded-md">
              <CheckSquare className="h-8 w-8 mx-auto mb-2 opacity-40" />
              Select a ClickUp account to get started.
              <br />
              <a
                href="/settings?tab=integrations"
                className="text-primary hover:underline mt-1 inline-block"
              >
                Connect an account in Settings →
              </a>
            </div>
          ) : !browser.listId ? (
            <div className="py-12 text-center text-sm text-muted-foreground border rounded-md">
              Pick a workspace, space and list to load its tasks.
            </div>
          ) : tasksLoading ? (
            <div className="py-12 flex items-center justify-center gap-2 text-sm text-muted-foreground border rounded-md">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading tasks...
            </div>
          ) : !review || review.length === 0 ? (
            <div className="py-12 text-center text-sm text-muted-foreground border rounded-md">
              No cached tasks for this list yet.
              <br />
              <button
                onClick={() => browser.syncMutation.mutate()}
                className="text-primary hover:underline mt-1"
                disabled={browser.syncMutation.isPending}
              >
                Sync from ClickUp →
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
                    {included.length}/{review.length} tasks
                  </span>
                </div>
                {createPhase && (
                  <Textarea
                    value={phaseGoal}
                    onChange={(e) => setPhaseGoal(e.target.value)}
                    rows={1}
                    placeholder="Phase goal (optional)"
                    className="text-xs"
                  />
                )}
                {!createPhase && (
                  <p className="text-xs text-muted-foreground">
                    Features will be imported without a phase.
                  </p>
                )}
              </div>

              {/* Native overflow, not ScrollArea: its %-height viewport
                  resolves against the max-h flex chain as auto and never
                  scrolls (content just paints past the dialog). */}
              <div className="flex-1 min-h-0 overflow-y-auto border rounded-md">
                <div className="divide-y">
                  {review.map((task, i) => (
                    <div
                      key={task.clickUpTaskId}
                      className={cn(
                        "flex items-center gap-2.5 px-3 py-2",
                        !task.included && "opacity-50"
                      )}
                    >
                      <input
                        type="checkbox"
                        checked={task.included}
                        onChange={(e) => patchTask(i, { included: e.target.checked })}
                        className="h-3.5 w-3.5 shrink-0 accent-primary"
                        title="Import this task"
                      />
                      <TaskStateIcon statusType={task.statusType} />
                      <Input
                        value={task.title}
                        onChange={(e) => patchTask(i, { title: e.target.value })}
                        className={cn("h-7 flex-1 text-xs", task.isSubtask && "ml-4")}
                        disabled={!task.included}
                      />
                      {task.clickUpStatus && (
                        <Badge variant="outline" className="text-xs py-0 shrink-0">
                          {task.clickUpStatus}
                        </Badge>
                      )}
                      <Badge variant="secondary" className="text-xs py-0 shrink-0">
                        → {task.status}
                      </Badge>
                      <a
                        href={task.url}
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
