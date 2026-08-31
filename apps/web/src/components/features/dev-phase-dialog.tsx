"use client";

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Loader2,
} from "lucide-react";
import {
  createDevPhase,
  updateDevPhase,
  type DevPhase,
  type DevPhaseStatus,
} from "@/services/dev-phases";

export const DEV_PHASE_STATUSES: {
  value: DevPhaseStatus;
  label: string;
  dotClassName: string;
}[] = [
  { value: "planned", label: "Planned", dotClassName: "bg-slate-400" },
  { value: "in_progress", label: "In progress", dotClassName: "bg-amber-400" },
  { value: "done", label: "Done", dotClassName: "bg-emerald-400" },
];

export function devPhaseStatusConfig(status: string) {
  return (
    DEV_PHASE_STATUSES.find((s) => s.value === status) ?? DEV_PHASE_STATUSES[0]
  );
}

// Create (phase = null) or edit (phase set) a development phase.
export function DevPhaseDialog({
  projectId,
  phase,
  open,
  onOpenChange,
}: {
  projectId: string;
  phase: DevPhase | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {phase ? "Edit dev phase" : "New dev phase"}
          </DialogTitle>
        </DialogHeader>
        {/* Keyed remount resets the form per phase / per open. */}
        {open && (
          <DevPhaseForm
            key={phase?.id ?? "new"}
            projectId={projectId}
            phase={phase}
            onDone={() => onOpenChange(false)}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function DevPhaseForm({
  projectId,
  phase,
  onDone,
}: {
  projectId: string;
  phase: DevPhase | null;
  onDone: () => void;
}) {
  const qc = useQueryClient();
  const [name, setName] = useState(phase?.name ?? "");
  const [goal, setGoal] = useState(phase?.goal ?? "");
  const [status, setStatus] = useState<DevPhaseStatus>(
    (phase?.status as DevPhaseStatus) ?? "planned"
  );

  const mutation = useMutation({
    mutationFn: () =>
      phase
        ? updateDevPhase(projectId, phase.id, {
            name: name.trim(),
            goal: goal.trim() || null,
            status,
          })
        : createDevPhase(projectId, {
            name: name.trim(),
            goal: goal.trim() || undefined,
            status,
          }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["dev-phases", projectId] });
      qc.invalidateQueries({ queryKey: ["features", projectId] });
      onDone();
    },
  });

  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (name.trim()) mutation.mutate();
      }}
    >
          <div className="grid gap-1.5">
            <Label htmlFor="dev-phase-name">Name</Label>
            <Input
              id="dev-phase-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder='e.g. "MVP" or "Fase 2 — Pagos"'
              autoFocus
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="dev-phase-goal">Goal (optional)</Label>
            <Textarea
              id="dev-phase-goal"
              value={goal}
              onChange={(e) => setGoal(e.target.value)}
              placeholder="What shipping this phase proves"
              rows={3}
            />
          </div>
          <div className="grid gap-1.5">
            <Label>Status</Label>
            <Select
              value={status}
              onValueChange={(v) => v && setStatus(v as DevPhaseStatus)}
            >
              <SelectTrigger className="w-40">
                <SelectValue>
                  {(v) => devPhaseStatusConfig(v as string).label}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {DEV_PHASE_STATUSES.map((s) => (
                  <SelectItem key={s.value} value={s.value}>
                    {s.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {mutation.isError && (
            <p className="text-xs text-destructive">
              {(mutation.error as Error).message}
            </p>
          )}
      <DialogFooter>
        <Button
          type="submit"
          size="sm"
          disabled={mutation.isPending || !name.trim()}
        >
          {mutation.isPending ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : phase ? (
            "Save"
          ) : (
            "Create"
          )}
        </Button>
      </DialogFooter>
    </form>
  );
}
