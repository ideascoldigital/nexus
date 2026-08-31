"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { getPhases, setPhaseStatus, type Phase, type PhaseStatus } from "@/services/definition";
import { Lock, Play, CheckCircle2, RotateCcw } from "lucide-react";

const STATUS_LABEL: Record<PhaseStatus, string> = {
  locked: "Locked",
  active: "Active",
  completed: "Done",
  revisiting: "Revisiting",
};

const STATUS_CLASS: Record<PhaseStatus, string> = {
  locked: "bg-muted text-muted-foreground",
  active: "bg-emerald-500/15 text-emerald-400",
  completed: "bg-blue-500/15 text-blue-400",
  revisiting: "bg-amber-500/15 text-amber-400",
};

function StatusBadge({ status }: { status: PhaseStatus }) {
  return (
    <span className={`text-[10px] px-2 py-0.5 rounded-full ${STATUS_CLASS[status]}`}>
      {STATUS_LABEL[status]}
    </span>
  );
}

export function PhaseNavigator({
  projectId,
  selectedPhaseKey,
  onSelectPhase,
}: {
  projectId: string;
  selectedPhaseKey: string | null;
  onSelectPhase: (key: string) => void;
}) {
  const queryClient = useQueryClient();
  const { data: phases, isLoading } = useQuery({
    queryKey: ["definer-phases", projectId],
    queryFn: () => getPhases(projectId),
  });

  const mutate = useMutation({
    mutationFn: ({ key, status }: { key: string; status: PhaseStatus }) =>
      setPhaseStatus(projectId, key, status),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["definer-phases", projectId] });
    },
  });

  if (isLoading) {
    return (
      <Card className="border-border/50">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-medium">Phases</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="border-border/50">
      <CardHeader className="pb-3">
        <CardTitle className="text-sm font-medium">Phases</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        {phases?.map((phase: Phase) => {
          const selected = phase.key === selectedPhaseKey;
          return (
            <div
              key={phase.id}
              className={`rounded-lg border p-2 cursor-pointer transition-colors ${
                selected ? "border-primary bg-primary/5" : "border-border/50 hover:bg-muted/40"
              }`}
              onClick={() => onSelectPhase(phase.key)}
            >
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-xs font-medium truncate">
                    {phase.order}. {phase.title}
                  </p>
                  {phase.summary && (
                    <p className="text-[10px] text-muted-foreground truncate">
                      {phase.summary}
                    </p>
                  )}
                </div>
                <StatusBadge status={phase.status} />
              </div>
              {/* Wrap: four actions overflow the narrow phases column otherwise. */}
              <div className="flex flex-wrap gap-1 mt-2">
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 px-1.5 text-[10px]"
                  onClick={(e) => {
                    e.stopPropagation();
                    mutate.mutate({ key: phase.key, status: "active" });
                  }}
                  disabled={phase.status === "active" || mutate.isPending}
                >
                  <Play className="h-3 w-3 mr-1" /> Active
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 px-1.5 text-[10px]"
                  onClick={(e) => {
                    e.stopPropagation();
                    mutate.mutate({ key: phase.key, status: "revisiting" });
                  }}
                  disabled={mutate.isPending}
                >
                  <RotateCcw className="h-3 w-3 mr-1" /> Revisit
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 px-1.5 text-[10px]"
                  onClick={(e) => {
                    e.stopPropagation();
                    mutate.mutate({ key: phase.key, status: "completed" });
                  }}
                  disabled={mutate.isPending}
                >
                  <CheckCircle2 className="h-3 w-3 mr-1" /> Done
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 px-1.5 text-[10px]"
                  onClick={(e) => {
                    e.stopPropagation();
                    mutate.mutate({ key: phase.key, status: "locked" });
                  }}
                  disabled={mutate.isPending}
                >
                  <Lock className="h-3 w-3 mr-1" /> Lock
                </Button>
              </div>
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}
