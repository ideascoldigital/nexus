"use client";

import { useEffect, useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import {
  Loader2,
  Sparkles,
  X,
} from "lucide-react";
import {
  applyRoadmap,
  generateRoadmap,
  type RoadmapProposal,
} from "@/services/roadmap";
import { FEATURE_PRIORITIES } from "@/types";
import { priorityConfig } from "./feature-card";

// Local review state: the proposal plus include-flags, all editable before
// anything is persisted.
type ReviewFeature = {
  included: boolean;
  title: string;
  description: string;
  priority: string;
  criteriaText: string; // one per line
  sourceSectionKeys: string[];
};

type ReviewPhase = {
  included: boolean;
  name: string;
  goal: string;
  sourceSectionKeys: string[];
  features: ReviewFeature[];
};

function toReview(proposal: RoadmapProposal): ReviewPhase[] {
  return proposal.phases.map((p) => ({
    included: true,
    name: p.name,
    goal: p.goal,
    sourceSectionKeys: p.sourceSectionKeys,
    features: p.features.map((f) => ({
      included: true,
      title: f.title,
      description: f.description,
      priority: f.priority,
      criteriaText: f.acceptanceCriteria.join("\n"),
      sourceSectionKeys: f.sourceSectionKeys,
    })),
  }));
}

function toProposal(review: ReviewPhase[]): RoadmapProposal {
  return {
    phases: review
      .filter((p) => p.included)
      .map((p, i) => ({
        name: p.name.trim(),
        goal: p.goal,
        order: i,
        sourceSectionKeys: p.sourceSectionKeys,
        features: p.features
          .filter((f) => f.included && f.title.trim())
          .map((f) => ({
            title: f.title.trim(),
            description: f.description,
            priority: f.priority as RoadmapProposal["phases"][number]["features"][number]["priority"],
            acceptanceCriteria: f.criteriaText
              .split("\n")
              .map((l) => l.trim())
              .filter(Boolean),
            sourceSectionKeys: f.sourceSectionKeys,
          })),
      }))
      .filter((p) => p.name),
  };
}

export function GenerateRoadmapDialog({
  projectId,
  hasExistingPhases,
  open,
  onOpenChange,
}: {
  projectId: string;
  hasExistingPhases: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const qc = useQueryClient();
  const [review, setReview] = useState<ReviewPhase[] | null>(null);
  const [sectionTitles, setSectionTitles] = useState<Record<string, string>>(
    {}
  );

  const generateMutation = useMutation({
    mutationFn: () => generateRoadmap(projectId),
    onSuccess: (data) => {
      setReview(toReview(data.proposal));
      setSectionTitles(data.sectionTitles);
    },
  });

  const applyMutation = useMutation({
    mutationFn: (proposal: RoadmapProposal) =>
      applyRoadmap(projectId, proposal, sectionTitles),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["features", projectId] });
      qc.invalidateQueries({ queryKey: ["dev-phases", projectId] });
      handleOpenChange(false);
    },
  });

  const handleOpenChange = (next: boolean) => {
    onOpenChange(next);
    if (!next) {
      setReview(null);
      generateMutation.reset();
      applyMutation.reset();
    }
  };

  // Kick off generation whenever the dialog opens fresh — the parent opens it
  // by setting `open` directly, so onOpenChange never fires for that case.
  const { mutate: generate, isPending: generating, isError: generateFailed } =
    generateMutation;
  useEffect(() => {
    if (open && !review && !generating && !generateFailed) generate();
  }, [open, review, generating, generateFailed, generate]);

  const counts = useMemo(() => {
    const phases = (review ?? []).filter((p) => p.included);
    return {
      phases: phases.length,
      features: phases.reduce(
        (n, p) => n + p.features.filter((f) => f.included).length,
        0
      ),
    };
  }, [review]);

  const patchPhase = (i: number, patch: Partial<ReviewPhase>) =>
    setReview((prev) =>
      prev ? prev.map((p, idx) => (idx === i ? { ...p, ...patch } : p)) : prev
    );

  const patchFeature = (i: number, j: number, patch: Partial<ReviewFeature>) =>
    setReview((prev) =>
      prev
        ? prev.map((p, idx) =>
            idx === i
              ? {
                  ...p,
                  features: p.features.map((f, fdx) =>
                    fdx === j ? { ...f, ...patch } : f
                  ),
                }
              : p
          )
        : prev
    );

  const sourceBadges = (keys: string[]) =>
    keys.length > 0 && (
      <div className="flex flex-wrap gap-1">
        {keys.map((k) => (
          <Badge
            key={k}
            variant="outline"
            className="h-4 text-[9px] text-muted-foreground"
            title={sectionTitles[k] ?? k}
          >
            {sectionTitles[k] ?? k}
          </Badge>
        ))}
      </div>
    );

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="flex max-h-[85vh] flex-col sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-primary" />
            Generate roadmap from definition
          </DialogTitle>
          <DialogDescription>
            The AI reads the definition document and proposes development
            phases with features. Nothing is saved until you apply.
            {hasExistingPhases && (
              <span className="mt-1 block text-amber-400/90">
                This project already has dev phases — applying adds to the
                existing roadmap.
              </span>
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-y-auto pr-1">
          {generateMutation.isPending && (
            <div className="flex flex-col items-center gap-2 py-16 text-sm text-muted-foreground">
              <Loader2 className="h-5 w-5 animate-spin" />
              Reading definition and drafting the roadmap…
            </div>
          )}

          {generateMutation.isError && (
            <div className="space-y-3 py-8 text-center">
              <p className="text-sm text-destructive">
                {(generateMutation.error as Error).message}
              </p>
              <Button
                size="sm"
                variant="outline"
                onClick={() => generateMutation.mutate()}
                className="gap-1.5"
              >
                Retry
              </Button>
            </div>
          )}

          {review && (
            <div className="space-y-4">
              {review.map((phase, i) => (
                <div
                  key={i}
                  className={cn(
                    "rounded-lg border p-3 space-y-3",
                    phase.included
                      ? "border-border/60"
                      : "border-border/30 opacity-50"
                  )}
                >
                  <div className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={phase.included}
                      onChange={(e) =>
                        patchPhase(i, { included: e.target.checked })
                      }
                      className="h-3.5 w-3.5 accent-primary"
                      title="Include this phase"
                    />
                    <Input
                      value={phase.name}
                      onChange={(e) => patchPhase(i, { name: e.target.value })}
                      className="h-7 flex-1 text-sm font-medium"
                      disabled={!phase.included}
                    />
                    <span className="font-mono text-[10px] text-muted-foreground">
                      {phase.features.filter((f) => f.included).length} features
                    </span>
                  </div>
                  <Textarea
                    value={phase.goal}
                    onChange={(e) => patchPhase(i, { goal: e.target.value })}
                    rows={2}
                    placeholder="Phase goal"
                    className="text-xs"
                    disabled={!phase.included}
                  />
                  {sourceBadges(phase.sourceSectionKeys)}

                  <div className="space-y-2">
                    {phase.features.map((feature, j) => (
                      <div
                        key={j}
                        className={cn(
                          "rounded-md border border-border/40 bg-muted/20 p-2.5 space-y-2",
                          (!feature.included || !phase.included) && "opacity-50"
                        )}
                      >
                        <div className="flex items-center gap-2">
                          <input
                            type="checkbox"
                            checked={feature.included}
                            onChange={(e) =>
                              patchFeature(i, j, { included: e.target.checked })
                            }
                            className="h-3.5 w-3.5 shrink-0 accent-primary"
                            title="Include this feature"
                            disabled={!phase.included}
                          />
                          <Input
                            value={feature.title}
                            onChange={(e) =>
                              patchFeature(i, j, { title: e.target.value })
                            }
                            className="h-7 flex-1 text-xs"
                            disabled={!phase.included || !feature.included}
                          />
                          <Select
                            value={feature.priority}
                            onValueChange={(v) =>
                              v && patchFeature(i, j, { priority: v as string })
                            }
                          >
                            <SelectTrigger className="h-7 w-24 text-xs">
                              <SelectValue>
                                {(v) =>
                                  priorityConfig[
                                    v as keyof typeof priorityConfig
                                  ]?.label ?? String(v)
                                }
                              </SelectValue>
                            </SelectTrigger>
                            <SelectContent>
                              {FEATURE_PRIORITIES.map((p) => (
                                <SelectItem key={p} value={p}>
                                  {priorityConfig[p].label}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                          <button
                            type="button"
                            onClick={() =>
                              patchFeature(i, j, { included: false })
                            }
                            className="text-muted-foreground/50 hover:text-destructive"
                            title="Discard feature"
                          >
                            <X className="h-3.5 w-3.5" />
                          </button>
                        </div>
                        <Textarea
                          value={feature.description}
                          onChange={(e) =>
                            patchFeature(i, j, { description: e.target.value })
                          }
                          rows={2}
                          placeholder="Description"
                          className="text-xs"
                          disabled={!phase.included || !feature.included}
                        />
                        <Textarea
                          value={feature.criteriaText}
                          onChange={(e) =>
                            patchFeature(i, j, { criteriaText: e.target.value })
                          }
                          rows={2}
                          placeholder="Acceptance criteria — one per line"
                          className="font-mono text-[11px]"
                          disabled={!phase.included || !feature.included}
                        />
                        {sourceBadges(feature.sourceSectionKeys)}
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {review && (
          <DialogFooter className="items-center border-t border-border/40 pt-3 sm:justify-between">
            <div className="flex items-center gap-3">
              <span className="text-xs text-muted-foreground">
                {counts.phases} phase{counts.phases !== 1 ? "s" : ""},{" "}
                {counts.features} feature{counts.features !== 1 ? "s" : ""}{" "}
                selected
              </span>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => generateMutation.mutate()}
                disabled={generateMutation.isPending || applyMutation.isPending}
                className="gap-1.5"
              >
                Regenerate
              </Button>
            </div>
            <div className="flex items-center gap-2">
              {applyMutation.isError && (
                <span className="text-xs text-destructive">
                  {(applyMutation.error as Error).message}
                </span>
              )}
              <Button
                size="sm"
                onClick={() => applyMutation.mutate(toProposal(review))}
                disabled={
                  applyMutation.isPending ||
                  counts.phases === 0 ||
                  counts.features === 0
                }
                className="gap-1.5"
              >
                {applyMutation.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                Apply roadmap
              </Button>
            </div>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}
