"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { getFeatures, updateFeature } from "@/services/features";
import type { FeatureWithCounts } from "@/services/features";
import { getDevPhases } from "@/services/dev-phases";
import { FEATURE_STATUSES } from "@/types";
import { getSandboxes } from "@/services/sandbox";
import type { FeatureStatus } from "@/types";
import { FeatureCard, statusConfig } from "./feature-card";
import { CreateFeatureDialog } from "./create-feature-dialog";
import { EditFeatureDialog } from "./edit-feature-dialog";
import { RunOnSandboxDialog } from "./run-on-sandbox-dialog";
import { DevPhaseBar, type DevPhaseFilter } from "./dev-phase-bar";
import { GenerateRoadmapDialog } from "./generate-roadmap-dialog";
import { ClickUpImportDialog } from "@/components/clickup/clickup-import-dialog";
import { GitHubImportDialog } from "@/components/github/github-import-dialog";
import { GitHubProjectImportDialog } from "@/components/github/github-project-import-dialog";
import { GitLabImportDialog } from "@/components/gitlab/gitlab-import-dialog";
import { Button } from "@/components/ui/button";
import { BrandIcon } from "@/components/ui/brand-icon";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  CheckSquare,
  ChevronDown,
  GitBranch,
  Import,
  KanbanSquare,
  Loader2,
  RefreshCw,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";

interface FeatureListProps {
  projectId: string;
}

export function FeatureList({ projectId }: FeatureListProps) {
  const [editingFeature, setEditingFeature] =
    useState<FeatureWithCounts | null>(null);
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [runningFeature, setRunningFeature] =
    useState<FeatureWithCounts | null>(null);
  const [phaseFilter, setPhaseFilter] = useState<DevPhaseFilter>("all");
  const [roadmapOpen, setRoadmapOpen] = useState(false);
  const [dropTarget, setDropTarget] = useState<FeatureStatus | null>(null);
  // One Import button, one menu — the source picked here opens its dialog.
  const [importSource, setImportSource] = useState<
    "github-project" | "github-issues" | "clickup" | "gitlab" | null
  >(null);
  const qc = useQueryClient();
  const { toast } = useToast();

  // Present only after an "Import GitHub Project" — powers the re-sync button.
  const { data: ghProjectLink } = useQuery<{ title: string } | null>({
    queryKey: ["github-project-link", projectId],
    queryFn: async () => {
      const res = await fetch(`/api/projects/${projectId}/github-project-link`);
      if (!res.ok) return null;
      return res.json();
    },
  });

  const ghSyncMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/projects/${projectId}/github-project-sync`, {
        method: "POST",
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Sync failed");
      }
      return res.json() as Promise<{ checked: number; updated: number }>;
    },
    onSuccess: (data) => {
      toast({
        title:
          data.updated === 0
            ? "Board already in sync"
            : `Updated ${data.updated} feature${data.updated === 1 ? "" : "s"} from the GitHub board`,
      });
      qc.invalidateQueries({ queryKey: ["features", projectId] });
      qc.invalidateQueries({ queryKey: ["dev-phases", projectId] });
    },
    onError: (err: Error) => {
      toast({ title: "Sync failed", description: err.message, variant: "destructive" });
    },
  });

  const {
    data: features,
    isLoading,
    isError,
    error,
  } = useQuery({
    queryKey: ["features", projectId],
    queryFn: () => getFeatures(projectId),
  });

  const devPhases = useQuery({
    queryKey: ["dev-phases", projectId],
    queryFn: () => getDevPhases(projectId),
  });

  // Drag a card onto a column → change its status. Optimistic: the card
  // jumps immediately, rolls back if the PUT fails.
  const moveMutation = useMutation({
    mutationFn: ({ id, status }: { id: string; status: FeatureStatus }) =>
      updateFeature(projectId, id, { status }),
    onMutate: async ({ id, status }) => {
      await qc.cancelQueries({ queryKey: ["features", projectId] });
      const previous = qc.getQueryData<FeatureWithCounts[]>([
        "features",
        projectId,
      ]);
      qc.setQueryData<FeatureWithCounts[]>(
        ["features", projectId],
        (old) => old?.map((f) => (f.id === id ? { ...f, status } : f)) ?? old
      );
      return { previous };
    },
    onError: (_err, _vars, ctx) => {
      if (ctx?.previous) {
        qc.setQueryData(["features", projectId], ctx.previous);
      }
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ["features", projectId] });
    },
  });

  // Queue column needs to know whether a dev sandbox exists to dispatch to.
  const sandboxes = useQuery({
    queryKey: ["sandboxes", projectId],
    queryFn: () => getSandboxes(projectId),
  });
  const devSandbox = sandboxes.data?.find(
    (sb) => sb.dedicated && sb.status === "running",
  );

  const handleDrop = (status: FeatureStatus, e: React.DragEvent) => {
    e.preventDefault();
    setDropTarget(null);
    const id = e.dataTransfer.getData("text/nexux-feature-id");
    if (!id) return;
    const feature = (features ?? []).find((f) => f.id === id);
    if (feature && feature.status !== status) {
      moveMutation.mutate({ id, status });
    }
  };

  function handleFeatureClick(feature: FeatureWithCounts) {
    setEditingFeature(feature);
    setEditDialogOpen(true);
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (isError) {
    return (
      <div className="flex items-center justify-center py-16">
        <p className="text-sm text-destructive">
          {error.message || "Failed to load features"}
        </p>
      </div>
    );
  }

  // Dev-phase filter runs before the status grouping — the kanban itself
  // stays a plain status board.
  const visible = (features ?? []).filter((f) =>
    phaseFilter === "all"
      ? true
      : phaseFilter === "none"
        ? !f.devPhaseId
        : f.devPhaseId === phaseFilter
  );

  const grouped = FEATURE_STATUSES.reduce(
    (acc, status) => {
      acc[status] = visible.filter((f) => f.status === status);
      return acc;
    },
    {} as Record<FeatureStatus, FeatureWithCounts[]>
  );

  const totalCount = features?.length ?? 0;
  const noPhaseCount = (features ?? []).filter((f) => !f.devPhaseId).length;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          {totalCount} feature{totalCount !== 1 ? "s" : ""}
        </p>
        <div className="flex items-center gap-2 flex-wrap justify-end">
          {ghProjectLink && (
            <Button
              size="sm"
              variant="outline"
              className="gap-1.5"
              onClick={() => ghSyncMutation.mutate()}
              disabled={ghSyncMutation.isPending}
              title={`Pull column/iteration changes from "${ghProjectLink.title}"`}
            >
              {ghSyncMutation.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <RefreshCw className="h-4 w-4" />
              )}
              Sync board
            </Button>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger
              render={<Button size="sm" variant="outline" className="gap-1.5" />}
            >
              <Import className="h-4 w-4" />
              Import
              <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => setImportSource("github-project")}>
                <KanbanSquare className="h-3.5 w-3.5" /> GitHub Project board
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setImportSource("github-issues")}>
                <GitBranch className="h-3.5 w-3.5" /> GitHub issues
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setImportSource("gitlab")}>
                <BrandIcon brand="gitlab" className="h-3.5 w-3.5" /> GitLab issues
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setImportSource("clickup")}>
                <CheckSquare className="h-3.5 w-3.5" /> ClickUp tasks
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <GitHubProjectImportDialog
            projectId={projectId}
            open={importSource === "github-project"}
            onOpenChange={(o) => !o && setImportSource(null)}
          />
          <GitHubImportDialog
            projectId={projectId}
            open={importSource === "github-issues"}
            onOpenChange={(o) => !o && setImportSource(null)}
          />
          <GitLabImportDialog
            projectId={projectId}
            open={importSource === "gitlab"}
            onOpenChange={(o) => !o && setImportSource(null)}
          />
          <ClickUpImportDialog
            projectId={projectId}
            open={importSource === "clickup"}
            onOpenChange={(o) => !o && setImportSource(null)}
          />
          <Button
            size="sm"
            variant="outline"
            className="gap-1.5"
            onClick={() => setRoadmapOpen(true)}
            title="AI proposes dev phases and features from the definition document — you review before anything is created"
          >
            Generate from definition
          </Button>
          <CreateFeatureDialog projectId={projectId}>
            <Button size="sm" className="gap-1.5">
              Add Feature
            </Button>
          </CreateFeatureDialog>
        </div>
      </div>

      <DevPhaseBar
        projectId={projectId}
        phases={devPhases.data ?? []}
        noPhaseCount={noPhaseCount}
        totalCount={totalCount}
        filter={phaseFilter}
        onFilterChange={setPhaseFilter}
      />

      {/* Kanban columns (prototype 1c): one column per status. */}
      {/* min-h so columns keep a drop surface below their cards — without it
          the section ends at its content and drops "under the column" miss. */}
      <div className="flex min-h-[calc(100svh-16rem)] gap-4 overflow-x-auto pb-2">
        {FEATURE_STATUSES.map((status) => {
          const items = grouped[status];
          const config = statusConfig[status];

          return (
            <section
              key={status}
              className={cn(
                "flex min-w-[240px] flex-1 flex-col rounded-lg p-1.5 -m-1.5 transition-colors",
                dropTarget === status && "bg-primary/10 ring-2 ring-primary/40"
              )}
              onDragOver={(e) => {
                e.preventDefault();
                e.dataTransfer.dropEffect = "move";
                if (dropTarget !== status) setDropTarget(status);
              }}
              onDragLeave={(e) => {
                // Only clear when actually leaving the column, not moving
                // between its children.
                if (!e.currentTarget.contains(e.relatedTarget as Node)) {
                  setDropTarget(null);
                }
              }}
              onDrop={(e) => handleDrop(status, e)}
            >
              <div className="mb-3 flex items-center gap-2">
                <span
                  className={cn(
                    "h-2 w-2 rounded-full",
                    config.className.includes("amber")
                      ? "bg-amber-400"
                      : config.className.includes("emerald") ||
                          config.className.includes("green")
                        ? "bg-primary"
                        : config.className.includes("blue") ||
                            config.className.includes("violet") ||
                            config.className.includes("purple")
                          ? "bg-primary/70"
                          : "bg-muted-foreground/50",
                  )}
                />
                <h3 className="font-mono text-[11px] uppercase tracking-[0.1em] text-foreground/80">
                  {config.label}
                </h3>
                <span className="font-mono text-[10.5px] text-muted-foreground">
                  {items.length}
                </span>
              </div>

              {status === "queued" &&
                (devSandbox ? (
                  <p className="mb-2 font-mono text-[10px] text-muted-foreground">
                    → {devSandbox.name}
                  </p>
                ) : (
                  <p className="mb-2 rounded-md border border-amber-400/30 bg-amber-400/10 px-2 py-1 text-[10px] text-amber-300/90">
                    No dev sandbox — items wait here until one is running
                  </p>
                ))}

              <div className="flex flex-1 flex-col gap-2.5">
                {items.map((feature) => (
                  <FeatureCard
                    key={feature.id}
                    feature={feature}
                    onClick={handleFeatureClick}
                    onRun={setRunningFeature}
                    onDragStart={(f, e) => {
                      e.dataTransfer.setData("text/nexux-feature-id", f.id);
                      e.dataTransfer.effectAllowed = "move";
                    }}
                  />
                ))}
                {dropTarget === status ? (
                  <div className="rounded-lg border-2 border-dashed border-primary/50 bg-primary/5 py-4 text-center text-xs font-medium text-primary">
                    Drop here — {config.label}
                  </div>
                ) : (
                  items.length === 0 && (
                    <p className="rounded-lg border border-dashed border-border/50 py-4 text-center text-xs text-muted-foreground/60">
                      —
                    </p>
                  )
                )}
              </div>
            </section>
          );
        })}
      </div>

      <GenerateRoadmapDialog
        projectId={projectId}
        hasExistingPhases={(devPhases.data?.length ?? 0) > 0}
        open={roadmapOpen}
        onOpenChange={setRoadmapOpen}
      />

      <EditFeatureDialog
        projectId={projectId}
        feature={editingFeature}
        open={editDialogOpen}
        onOpenChange={(open) => {
          setEditDialogOpen(open);
          if (!open) setEditingFeature(null);
        }}
      />

      {runningFeature && (
        <RunOnSandboxDialog
          projectId={projectId}
          feature={runningFeature}
          open={true}
          onOpenChange={(open) => {
            if (!open) setRunningFeature(null);
          }}
        />
      )}
    </div>
  );
}
