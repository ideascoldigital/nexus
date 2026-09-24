"use client";

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import {
  ArrowLeft,
  ArrowRight,
  MoreHorizontal,
  Pencil,
  Plus,
  Trash2,
} from "lucide-react";
import {
  deleteDevPhase,
  reorderDevPhases,
  type DevPhase,
} from "@/services/dev-phases";
import { DevPhaseDialog, devPhaseStatusConfig } from "./dev-phase-dialog";

/** Filter value: "all" | "none" (features without phase) | a DevPhase id. */
export type DevPhaseFilter = "all" | "none" | string;

// Horizontal roadmap strip above the kanban: one chip per dev phase acting
// as a filter, plus All / No phase / new-phase chips.
export function DevPhaseBar({
  projectId,
  phases,
  noPhaseCount,
  totalCount,
  filter,
  onFilterChange,
}: {
  projectId: string;
  phases: DevPhase[];
  noPhaseCount: number;
  totalCount: number;
  filter: DevPhaseFilter;
  onFilterChange: (filter: DevPhaseFilter) => void;
}) {
  const qc = useQueryClient();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<DevPhase | null>(null);

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["dev-phases", projectId] });
    qc.invalidateQueries({ queryKey: ["features", projectId] });
  };

  const deleteMutation = useMutation({
    mutationFn: (devPhaseId: string) => deleteDevPhase(projectId, devPhaseId),
    onSuccess: (_, devPhaseId) => {
      if (filter === devPhaseId) onFilterChange("all");
      invalidate();
    },
  });

  const reorderMutation = useMutation({
    mutationFn: (orderedIds: string[]) =>
      reorderDevPhases(projectId, orderedIds),
    onSuccess: invalidate,
  });

  const move = (phase: DevPhase, dir: -1 | 1) => {
    const ids = phases.map((p) => p.id);
    const i = ids.indexOf(phase.id);
    const j = i + dir;
    if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    reorderMutation.mutate(ids);
  };

  const chip = (
    active: boolean,
    onClick: () => void,
    content: React.ReactNode,
    key: string
  ) => (
    <button
      key={key}
      type="button"
      onClick={onClick}
      className={cn(
        // Real height below sm rather than a tap-target pseudo: these sit in a
        // scrollable row, and overlapping hit areas would make which phase you
        // selected depend on paint order.
        "flex h-9 shrink-0 items-center gap-1.5 rounded-full border px-3 text-xs transition-colors sm:h-auto sm:py-1",
        active
          ? "border-primary/50 bg-primary/10 text-foreground"
          : "border-border/50 text-muted-foreground hover:border-border hover:text-foreground"
      )}
    >
      {content}
    </button>
  );

  return (
    <>
      <div className="flex items-center gap-2 overflow-x-auto pb-1">
        {chip(
          filter === "all",
          () => onFilterChange("all"),
          <>
            All
            <span className="font-mono text-[10px] opacity-70">
              {totalCount}
            </span>
          </>,
          "all"
        )}
        {phases.map((phase) => {
          const status = devPhaseStatusConfig(phase.status);
          return (
            <div
              key={phase.id}
              className={cn(
                "flex shrink-0 items-center rounded-full border transition-colors",
                filter === phase.id
                  ? "border-primary/50 bg-primary/10"
                  : "border-border/50 hover:border-border"
              )}
            >
              <button
                type="button"
                onClick={() => onFilterChange(phase.id)}
                className={cn(
                  "flex items-center gap-1.5 py-1 pl-3 pr-1 text-xs",
                  filter === phase.id
                    ? "text-foreground"
                    : "text-muted-foreground hover:text-foreground"
                )}
                title={phase.goal ?? undefined}
              >
                <span
                  className={cn("h-1.5 w-1.5 rounded-full", status.dotClassName)}
                  title={status.label}
                />
                {phase.name}
                <span className="font-mono text-[10px] opacity-70">
                  {phase._count.features}
                </span>
              </button>
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={
                    <button
                      type="button"
                      className="rounded-full p-1 pr-1.5 text-muted-foreground/50 hover:text-foreground"
                      title={`Options for ${phase.name}`}
                    />
                  }
                >
                  <MoreHorizontal className="h-3 w-3" />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start">
                  <DropdownMenuItem
                    onClick={() => {
                      setEditing(phase);
                      setDialogOpen(true);
                    }}
                  >
                    <Pencil className="h-3.5 w-3.5" /> Edit
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => move(phase, -1)}>
                    <ArrowLeft className="h-3.5 w-3.5" /> Move left
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => move(phase, 1)}>
                    <ArrowRight className="h-3.5 w-3.5" /> Move right
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    variant="destructive"
                    onClick={() => {
                      if (
                        window.confirm(
                          `Delete phase "${phase.name}"? Its features are kept (they just lose the phase).`
                        )
                      ) {
                        deleteMutation.mutate(phase.id);
                      }
                    }}
                  >
                    <Trash2 className="h-3.5 w-3.5" /> Delete
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          );
        })}
        {noPhaseCount > 0 &&
          phases.length > 0 &&
          chip(
            filter === "none",
            () => onFilterChange("none"),
            <>
              No phase
              <span className="font-mono text-[10px] opacity-70">
                {noPhaseCount}
              </span>
            </>,
            "none"
          )}
        {chip(
          false,
          () => {
            setEditing(null);
            setDialogOpen(true);
          },
          <>
            <Plus className="h-3 w-3" />
            Phase
          </>,
          "new"
        )}
      </div>

      <DevPhaseDialog
        projectId={projectId}
        phase={editing}
        open={dialogOpen}
        onOpenChange={(open) => {
          setDialogOpen(open);
          if (!open) setEditing(null);
        }}
      />
    </>
  );
}
