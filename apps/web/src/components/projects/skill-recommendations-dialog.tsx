"use client";

// AI recommendations for Orchestrate (skills or agents): the server profiles
// the project (definition + package.json deps + stack) and ranks the best
// candidates from the workspace catalog and the public registry. Catalog
// picks attach in one click; registry picks install-then-attach; "Apply all"
// lands every pending recommendation in one pass.

import { useEffect, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Check, Download, Loader2, Sparkles } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { updateProjectAgents, updateProjectSkills } from "@/services/skills";

type Recommendation = {
  source: "catalog" | "registry";
  id: string;
  name: string;
  reason: string;
};

const KIND_COPY = {
  skills: {
    title: "Recommended skills",
    registryLabel: "skills.sh",
    installEndpoint: "/api/skills/registry/install",
    installBody: (id: string) => ({ id }),
  },
  agents: {
    title: "Recommended agents",
    registryLabel: "aitmpl.com",
    installEndpoint: "/api/agents/registry/install",
    installBody: (id: string) => ({ path: id }),
  },
} as const;

export function SkillRecommendationsDialog({
  projectId,
  kind,
  open,
  onOpenChange,
  attachedIds,
  onApplied,
}: {
  projectId: string;
  kind: "skills" | "agents";
  open: boolean;
  onOpenChange: (open: boolean) => void;
  attachedIds: Set<string>;
  onApplied: () => void;
}) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const copy = KIND_COPY[kind];
  const [items, setItems] = useState<Recommendation[] | null>(null);
  const [applied, setApplied] = useState<Set<string>>(new Set());
  // Ids attached during this dialog session — the attachedIds prop lags the
  // server between applies, so accumulate locally for correct PUTs.
  const extraIdsRef = useRef<Set<string>>(new Set());

  const analyze = useMutation({
    mutationFn: async () => {
      const res = await fetch(
        `/api/projects/${projectId}/orchestration/recommend`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ kind }),
        },
      );
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Recommendation failed");
      return body.recommendations as Recommendation[];
    },
    onSuccess: (recs) => setItems(recs),
  });

  // The parent opens the dialog via prop — onOpenChange won't fire for that,
  // so kick the analysis whenever it becomes visible without results.
  const { mutate: startAnalyze, isPending: analyzing } = analyze;
  useEffect(() => {
    if (open && !items && !analyzing) startAnalyze();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  /** Resolve a rec to a catalog id, installing from the registry if needed. */
  const resolveId = async (rec: Recommendation): Promise<string> => {
    if (rec.source === "catalog") return rec.id;
    const res = await fetch(copy.installEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(copy.installBody(rec.id)),
    });
    const body = await res.json();
    if (!res.ok && res.status !== 409) {
      throw new Error(body.error ?? `Install failed: ${rec.name}`);
    }
    if (!body.id) throw new Error(`Installed but could not resolve ${rec.name}`);
    return body.id as string;
  };

  const attach = async (ids: string[]) => {
    const all = [
      ...Array.from(attachedIds),
      ...Array.from(extraIdsRef.current),
      ...ids,
    ];
    if (kind === "skills") await updateProjectSkills(projectId, all);
    else await updateProjectAgents(projectId, all);
    ids.forEach((id) => extraIdsRef.current.add(id));
  };

  const apply = useMutation({
    mutationFn: async (rec: Recommendation) => {
      await attach([await resolveId(rec)]);
      return rec;
    },
    onSuccess: (rec) => {
      setApplied((prev) => new Set(prev).add(rec.id));
      qc.invalidateQueries({ queryKey: ["skills"] });
      qc.invalidateQueries({ queryKey: ["catalog-skills"] });
      qc.invalidateQueries({ queryKey: ["catalog-agents"] });
      onApplied();
      toast({ title: kind === "skills" ? "Skill attached" : "Agent attached", description: rec.name });
    },
    onError: (err) =>
      toast({
        title: "Could not apply",
        description: err instanceof Error ? err.message : undefined,
        variant: "destructive",
      }),
  });

  const isDone = (rec: Recommendation) =>
    applied.has(rec.id) ||
    (rec.source === "catalog" && attachedIds.has(rec.id));

  const applyAll = useMutation({
    mutationFn: async () => {
      const pending = (items ?? []).filter((r) => !isDone(r));
      const resolved: Array<{ rec: Recommendation; id: string }> = [];
      const failures: string[] = [];
      for (const rec of pending) {
        try {
          resolved.push({ rec, id: await resolveId(rec) });
        } catch (err) {
          failures.push(
            `${rec.name}: ${err instanceof Error ? err.message : "failed"}`,
          );
        }
      }
      if (resolved.length > 0) await attach(resolved.map((r) => r.id));
      return { resolved: resolved.map((r) => r.rec), failures };
    },
    onSuccess: ({ resolved, failures }) => {
      setApplied((prev) => {
        const next = new Set(prev);
        resolved.forEach((r) => next.add(r.id));
        return next;
      });
      qc.invalidateQueries({ queryKey: ["skills"] });
      qc.invalidateQueries({ queryKey: ["catalog-skills"] });
      qc.invalidateQueries({ queryKey: ["catalog-agents"] });
      onApplied();
      toast({
        title: `${resolved.length} applied`,
        description:
          failures.length > 0 ? `Failed: ${failures.join("; ")}` : undefined,
        ...(failures.length > 0 ? { variant: "destructive" as const } : {}),
      });
    },
  });

  const pendingCount = (items ?? []).filter((r) => !isDone(r)).length;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next);
        if (!next) {
          setItems(null);
          setApplied(new Set());
          extraIdsRef.current = new Set();
          analyze.reset();
        }
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-primary" />
            {copy.title}
          </DialogTitle>
          <DialogDescription>
            Ranked against this project&apos;s definition, dependencies and
            stack — attach the ones that fit.
          </DialogDescription>
        </DialogHeader>

        {analyze.isPending && (
          <p className="flex items-center gap-2 py-6 text-xs text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            Analyzing the project and ranking {kind}…
          </p>
        )}
        {analyze.isError && (
          <div className="space-y-2 py-4">
            <p className="text-xs text-destructive">
              {(analyze.error as Error).message}
            </p>
            <Button size="sm" variant="outline" onClick={() => analyze.mutate()}>
              Retry
            </Button>
          </div>
        )}
        {items && items.length === 0 && (
          <p className="py-6 text-center text-xs text-muted-foreground">
            Nothing to recommend — what&apos;s attached already covers this
            project.
          </p>
        )}
        {items && items.length > 0 && (
          <div className="max-h-[50vh] space-y-2 overflow-y-auto">
            {items.map((rec) => {
              const done = isDone(rec);
              return (
                <div
                  key={rec.id}
                  className="flex items-start gap-3 rounded-lg border border-border/50 bg-muted/20 p-3"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <p className="truncate text-sm font-medium">{rec.name}</p>
                      <Badge
                        variant={rec.source === "catalog" ? "secondary" : "outline"}
                        className="shrink-0 text-[10px]"
                      >
                        {rec.source === "catalog" ? "installed" : copy.registryLabel}
                      </Badge>
                    </div>
                    <p className="mt-1 text-[11px] leading-snug text-muted-foreground">
                      {rec.reason}
                    </p>
                  </div>
                  <Button
                    size="sm"
                    variant={done ? "ghost" : "default"}
                    disabled={done || apply.isPending || applyAll.isPending}
                    onClick={() => apply.mutate(rec)}
                    className="shrink-0 gap-1.5"
                  >
                    {done ? (
                      <>
                        <Check className="h-3.5 w-3.5 text-emerald-400" />
                        Attached
                      </>
                    ) : apply.isPending && apply.variables?.id === rec.id ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : rec.source === "registry" ? (
                      <>
                        <Download className="h-3.5 w-3.5" />
                        Install & attach
                      </>
                    ) : (
                      "Attach"
                    )}
                  </Button>
                </div>
              );
            })}
          </div>
        )}

        {items && items.length > 0 && (
          <DialogFooter>
            <Button
              onClick={() => applyAll.mutate()}
              disabled={pendingCount === 0 || applyAll.isPending || apply.isPending}
              className="gap-1.5"
            >
              {applyAll.isPending && (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              )}
              {pendingCount === 0
                ? "All applied"
                : `Apply all (${pendingCount})`}
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}
