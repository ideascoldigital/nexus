"use client";

// The skill library: what any brain can be taught. Sources (custom, user,
// project, plugins, built-in) each wear their own tint — on the filter
// pills, the group labels and the cards' hairline — so where a skill comes
// from is legible at every level without reading a word.

import { AppHeader } from "@/components/layout/app-header";
import { Button } from "@/components/ui/button";
import { SkillsRegistryBrowser } from "@/components/skills/skills-registry-browser";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  ChevronDown,
  ChevronRight,
  FileText,
  Lock,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Sparkles,
} from "lucide-react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { getSkills, syncSkills, type SkillWithCount } from "@/services/skills";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import Link from "next/link";
import { useMemo, useState } from "react";

const sourceOrder = ["custom", "user", "project", "plugin", "built-in"];
const sourceLabels: Record<string, string> = {
  custom: "Custom",
  user: "User (~/.claude/skills)",
  project: "Project (./.claude/skills)",
  plugin: "Plugins",
  "built-in": "Built-in",
};
/** One tint per origin, worn by pills, group labels and card hairlines. */
const sourceTint: Record<
  string,
  { pill: string; bar: string; icon: string; tile: string }
> = {
  custom: {
    pill: "border-emerald-500/30 bg-emerald-500/10 text-emerald-300",
    bar: "bg-emerald-400",
    icon: "text-emerald-300",
    tile: "border-emerald-500/20 bg-emerald-500/10",
  },
  user: {
    pill: "border-sky-500/30 bg-sky-500/10 text-sky-300",
    bar: "bg-sky-400",
    icon: "text-sky-300",
    tile: "border-sky-500/20 bg-sky-500/10",
  },
  project: {
    pill: "border-amber-400/30 bg-amber-400/10 text-amber-300",
    bar: "bg-amber-400",
    icon: "text-amber-300",
    tile: "border-amber-400/20 bg-amber-400/10",
  },
  plugin: {
    pill: "border-indigo-500/30 bg-indigo-500/10 text-indigo-300",
    bar: "bg-indigo-400",
    icon: "text-indigo-300",
    tile: "border-indigo-500/20 bg-indigo-500/10",
  },
  "built-in": {
    pill: "border-border/60 bg-muted/40 text-muted-foreground",
    bar: "bg-muted-foreground/40",
    icon: "text-muted-foreground",
    tile: "border-border/60 bg-muted/40",
  },
};
const tintOf = (source: string) => sourceTint[source] ?? sourceTint.custom;

function SkillCard({ skill, index }: { skill: SkillWithCount; index: number }) {
  const editable = !skill.isBuiltIn;
  const tint = tintOf(skill.source || "custom");
  const projects = skill._count.projectSkills;
  const card = (
    <Card
      className={cn(
        "group animate-in fade-in slide-in-from-bottom-2 fill-mode-backwards relative h-full overflow-hidden border-border/50 duration-300",
        editable
          ? "cursor-pointer transition-colors hover:border-border"
          : "opacity-90",
      )}
      style={{ animationDelay: `${Math.min(index * 35, 350)}ms` }}
    >
      <span
        className={cn("absolute top-3 bottom-3 left-0 w-0.5 rounded-full", tint.bar)}
      />
      <CardContent className="p-5">
        <div className="flex items-start gap-3">
          <div
            className={cn(
              "flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border transition-transform duration-300 group-hover:scale-105",
              tint.tile,
            )}
          >
            <Sparkles className={cn("h-4 w-4", tint.icon)} />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h3 className="truncate text-sm font-medium">{skill.name}</h3>
              {skill.isBuiltIn ? (
                <span
                  className="ml-auto flex shrink-0 items-center gap-1 text-[10px] text-muted-foreground"
                  title="Built-in — synced from disk, not editable here"
                >
                  <Lock className="h-3 w-3" />
                  built-in
                </span>
              ) : (
                <span className="ml-auto flex shrink-0 items-center gap-1 text-[10px] text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100">
                  <Pencil className="h-3 w-3" />
                  edit
                </span>
              )}
            </div>
            <p className="mt-1 line-clamp-2 min-h-8 text-xs text-muted-foreground">
              {skill.description || "No description."}
            </p>
            <div className="mt-3 flex items-center gap-2 text-[11px]">
              <span
                className={cn(
                  "flex items-center gap-1",
                  projects > 0
                    ? "text-emerald-300/90"
                    : "text-muted-foreground/70",
                )}
              >
                <FileText className="h-3 w-3" />
                {projects > 0
                  ? `${projects} project${projects === 1 ? "" : "s"}`
                  : "unused"}
              </span>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );

  if (!editable) return card;
  return <Link href={`/skills/${skill.id}/edit`}>{card}</Link>;
}

export default function SkillsPage() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [query, setQuery] = useState("");
  const [sourceFilter, setSourceFilter] = useState<string>("all");
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [registryOpen, setRegistryOpen] = useState(false);
  const toggleGroup = (source: string) =>
    setCollapsed((c) => ({ ...c, [source]: !c[source] }));

  const { data: skills, isLoading } = useQuery({
    queryKey: ["skills"],
    queryFn: getSkills,
  });

  const sourceCounts = useMemo(() => {
    const map: Record<string, number> = {};
    for (const s of skills ?? []) {
      const key = s.source || "custom";
      map[key] = (map[key] ?? 0) + 1;
    }
    return map;
  }, [skills]);

  const filtered = useMemo(() => {
    let list = skills ?? [];
    if (sourceFilter !== "all") {
      list = list.filter((s) => (s.source || "custom") === sourceFilter);
    }
    const q = query.trim().toLowerCase();
    if (!q) return list;
    return list.filter(
      (s) =>
        s.name.toLowerCase().includes(q) ||
        (s.description ?? "").toLowerCase().includes(q) ||
        s.source.toLowerCase().includes(q),
    );
  }, [skills, sourceFilter, query]);

  const grouped = useMemo(() => {
    const map = new Map<string, SkillWithCount[]>();
    for (const skill of filtered) {
      const key = skill.source || "custom";
      const arr = map.get(key) ?? [];
      arr.push(skill);
      map.set(key, arr);
    }
    const ordered: Array<[string, SkillWithCount[]]> = [];
    for (const key of sourceOrder) {
      const list = map.get(key);
      if (list && list.length) ordered.push([key, list]);
      map.delete(key);
    }
    for (const [key, list] of map) ordered.push([key, list]);
    return ordered;
  }, [filtered]);

  const syncMutation = useMutation({
    mutationFn: syncSkills,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["skills"] });
      toast({ title: "Success", description: "Skills synced from disk" });
    },
    onError: (error: Error) => {
      toast({
        title: "Error",
        description: error.message || "Failed to sync skills",
        variant: "destructive",
      });
    },
  });

  const filterPill = (id: string, label: string, count: number) => (
    <button
      key={id}
      type="button"
      onClick={() => setSourceFilter(id)}
      className={cn(
        // Real height below sm rather than a tap-target pseudo: these sit in a
        // row, and overlapping hit areas would make which filter you tapped
        // depend on paint order.
        "flex h-9 shrink-0 items-center gap-1.5 rounded-full border px-3 text-[11px] transition-colors sm:h-auto sm:px-2.5 sm:py-1",
        sourceFilter === id
          ? id === "all"
            ? "border-primary/40 bg-primary/10 text-foreground"
            : tintOf(id).pill
          : "border-border/60 text-muted-foreground hover:border-border hover:text-foreground",
      )}
    >
      {label}
      <span className="font-mono text-[10px] tabular-nums opacity-70">
        {count}
      </span>
    </button>
  );

  return (
    <>
      <AppHeader title="Skills" />
      <div className="flex-1 overflow-auto">
        <div className="mx-auto w-full max-w-page space-y-5 px-4 py-6">
          {/* ---- Hero ---------------------------------------------------- */}
          <header className="flex flex-wrap items-start justify-between gap-4 border-b border-border/60 pb-5">
            <div className="flex items-start gap-3">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-primary/20 bg-primary/10 text-primary">
                <Sparkles className="h-4.5 w-4.5" />
              </div>
              <div>
                <h1 className="text-base leading-tight font-semibold">
                  Skills
                </h1>
                <p className="mt-0.5 text-sm text-muted-foreground">
                  Reusable instructions any brain can load — materialized into
                  sandboxes as native ~/.claude skills.
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => syncMutation.mutate()}
                disabled={syncMutation.isPending}
              >
                <RefreshCw
                  className={cn(
                    "h-3.5 w-3.5",
                    syncMutation.isPending && "animate-spin",
                  )}
                />
                {syncMutation.isPending ? "Scanning…" : "Scan disk"}
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setRegistryOpen(true)}
                title="Browse and install skills from the skills.sh registry"
              >
                Browse skills.sh
              </Button>
              <Link href="/skills/new">
                <Button size="sm" className="gap-1.5">
                  <Plus className="h-3.5 w-3.5" />
                  New skill
                </Button>
              </Link>
            </div>
          </header>

          {/* ---- Toolbar ------------------------------------------------- */}
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative min-w-56 flex-1">
              <Search className="absolute top-1/2 left-3 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search skills by name, description or source…"
                className="h-9 pl-9 text-sm"
              />
            </div>
            <div className="flex flex-wrap gap-1.5">
              {filterPill("all", "All", skills?.length ?? 0)}
              {sourceOrder
                .filter((s) => (sourceCounts[s] ?? 0) > 0)
                .map((s) =>
                  filterPill(
                    s,
                    sourceLabels[s]?.split(" ")[0] ?? s,
                    sourceCounts[s] ?? 0,
                  ),
                )}
            </div>
          </div>

          {/* ---- Groups -------------------------------------------------- */}
          {isLoading ? (
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
              {[1, 2, 3, 4, 5, 6].map((i) => (
                <Card key={i} className="border-border/50">
                  <CardContent className="p-5">
                    <div className="animate-pulse space-y-3">
                      <div className="flex items-center gap-3">
                        <div className="h-9 w-9 rounded-lg bg-muted" />
                        <div className="flex-1 space-y-2">
                          <div className="h-4 w-24 rounded bg-muted" />
                          <div className="h-3 w-40 rounded bg-muted" />
                        </div>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          ) : (skills?.length ?? 0) === 0 ? (
            <div className="flex flex-col items-center justify-center py-20 text-center">
              <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-xl border border-primary/20 bg-primary/10">
                <Sparkles className="h-6 w-6 text-primary" />
              </div>
              <p className="mb-1 text-sm font-medium">No skills yet</p>
              <p className="mb-5 text-xs text-muted-foreground">
                Create one with AI, install from skills.sh, or scan the ones
                already on disk.
              </p>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => syncMutation.mutate()}
                >
                  <RefreshCw className="h-3.5 w-3.5" />
                  Scan disk
                </Button>
                <Link href="/skills/new">
                  <Button size="sm" className="gap-1.5">
                    <Plus className="h-3.5 w-3.5" />
                    New skill
                  </Button>
                </Link>
              </div>
            </div>
          ) : filtered.length === 0 ? (
            <div className="py-12 text-center text-sm text-muted-foreground">
              Nothing matches{query.trim() ? ` "${query.trim()}"` : ""}
              {sourceFilter !== "all"
                ? ` in ${sourceLabels[sourceFilter] ?? sourceFilter}`
                : ""}
              .
            </div>
          ) : (
            <div className="space-y-7">
              {grouped.map(([source, items]) => {
                const isCollapsed = collapsed[source];
                const tint = tintOf(source);
                return (
                  <section key={source} className="space-y-3">
                    <button
                      type="button"
                      onClick={() => toggleGroup(source)}
                      className="flex w-full items-center gap-2 text-left"
                    >
                      {isCollapsed ? (
                        <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
                      ) : (
                        <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
                      )}
                      <span className={cn("h-1.5 w-1.5 rounded-full", tint.bar)} />
                      <h2 className="text-[11px] font-semibold tracking-[0.14em] uppercase">
                        {sourceLabels[source] ?? source}
                      </h2>
                      <span className="font-mono text-[10px] text-muted-foreground tabular-nums">
                        {items.length}
                      </span>
                      <span className="ml-2 h-px flex-1 bg-border/50" />
                    </button>
                    {!isCollapsed && (
                      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
                        {items.map((skill, i) => (
                          <SkillCard key={skill.id} skill={skill} index={i} />
                        ))}
                      </div>
                    )}
                  </section>
                );
              })}
            </div>
          )}
        </div>
      </div>
      <SkillsRegistryBrowser
        open={registryOpen}
        onOpenChange={setRegistryOpen}
        installedNames={new Set((skills ?? []).map((sk) => sk.name))}
      />
    </>
  );
}
