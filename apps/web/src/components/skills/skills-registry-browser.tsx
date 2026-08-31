"use client";

// skills.sh browser: search the public registry, preview a skill's SKILL.md
// and install it into the active workspace's catalog.

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Download, ExternalLink, Loader2, Search } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { MarkdownReport } from "@/components/ui/markdown-report";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { useToast } from "@/hooks/use-toast";

type RegistrySkill = {
  id: string;
  skillId: string;
  name: string;
  installs: number;
  source: string;
};

type ResolvedSkill = {
  id: string;
  name: string;
  description: string;
  content: string;
  body: string;
  repoUrl: string;
};

function useDebounced(value: string, ms: number) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return debounced;
}

const fmtInstalls = (n: number) =>
  n >= 1_000_000
    ? `${(n / 1_000_000).toFixed(1)}M`
    : n >= 1_000
      ? `${(n / 1_000).toFixed(1)}k`
      : String(n);

export function SkillsRegistryBrowser({
  open,
  onOpenChange,
  installedNames,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  installedNames: Set<string>;
}) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<RegistrySkill | null>(null);
  const debounced = useDebounced(query, 300);
  // A default query so the drawer opens with content, not a blank slate.
  const effective = debounced.trim().length >= 2 ? debounced.trim() : "vercel";

  const results = useQuery({
    queryKey: ["skills-registry", effective],
    queryFn: async () => {
      const res = await fetch(
        `/api/skills/registry?q=${encodeURIComponent(effective)}`,
      );
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Search failed");
      return body.skills as RegistrySkill[];
    },
    enabled: open,
    staleTime: 60_000,
  });

  const detail = useQuery({
    queryKey: ["skills-registry-detail", selected?.id],
    queryFn: async () => {
      const res = await fetch(
        `/api/skills/registry/resolve?id=${encodeURIComponent(selected!.id)}`,
      );
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Could not load the skill");
      return body as ResolvedSkill;
    },
    enabled: open && selected !== null,
    staleTime: 5 * 60_000,
    retry: false,
  });

  const install = useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch("/api/skills/registry/install", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Install failed");
      return body;
    },
    onSuccess: (skill) => {
      qc.invalidateQueries({ queryKey: ["skills"] });
      toast({
        title: "Skill installed",
        description: `“${skill.name}” is now in this workspace — attach it to projects from Orchestrate.`,
      });
    },
    onError: (err) =>
      toast({
        title: "Install failed",
        description: err instanceof Error ? err.message : undefined,
        variant: "destructive",
      }),
  });

  const isInstalled = (name: string) => installedNames.has(name);

  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next);
        if (!next) {
          setSelected(null);
          setQuery("");
        }
      }}
    >
      <SheetContent
        side="right"
        className="flex w-full flex-col gap-0 p-0 data-[side=right]:sm:max-w-2xl"
      >
        <SheetHeader className="border-b border-border/60 px-4 py-3">
          <SheetTitle className="text-sm">
            {selected ? selected.name : "Browse skills.sh"}
          </SheetTitle>
          <SheetDescription className="text-xs">
            {selected
              ? selected.source
              : "The open agent-skills registry — search, preview and install into this workspace."}
          </SheetDescription>
        </SheetHeader>

        {!selected ? (
          <>
            <div className="border-b border-border/60 px-4 py-3">
              <div className="relative">
                <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input
                  autoFocus
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search skills… (react, testing, seo)"
                  className="pl-8 text-sm"
                />
              </div>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
              {results.isLoading && (
                <p className="flex items-center gap-2 py-8 text-xs text-muted-foreground">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  Searching skills.sh…
                </p>
              )}
              {results.isError && (
                <p className="py-8 text-xs text-destructive">
                  {(results.error as Error).message}
                </p>
              )}
              {results.data?.length === 0 && (
                <p className="py-8 text-center text-xs text-muted-foreground">
                  No skills match “{effective}”.
                </p>
              )}
              <div className="space-y-1.5">
                {results.data?.map((skill) => (
                  <button
                    key={skill.id}
                    type="button"
                    onClick={() => setSelected(skill)}
                    className="flex w-full items-center gap-3 rounded-lg border border-border/50 bg-muted/20 px-3 py-2.5 text-left transition-colors hover:border-border"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">
                        {skill.name}
                      </p>
                      <p className="truncate font-mono text-[10.5px] text-muted-foreground">
                        {skill.source}
                      </p>
                    </div>
                    {isInstalled(skill.name) && (
                      <Badge variant="outline" className="text-[10px] text-emerald-400">
                        installed
                      </Badge>
                    )}
                    <span className="shrink-0 font-mono text-[10.5px] text-muted-foreground">
                      {fmtInstalls(skill.installs)} installs
                    </span>
                  </button>
                ))}
              </div>
            </div>
          </>
        ) : (
          <>
            <div className="flex items-center gap-2 border-b border-border/60 px-4 py-2">
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setSelected(null)}
                className="gap-1.5"
              >
                <ArrowLeft className="h-3.5 w-3.5" />
                Back
              </Button>
              <span className="ml-auto font-mono text-[10.5px] text-muted-foreground">
                {fmtInstalls(selected.installs)} installs
              </span>
              {detail.data && (
                <a
                  href={detail.data.repoUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="text-muted-foreground hover:text-foreground"
                  title="View on GitHub"
                >
                  <ExternalLink className="h-3.5 w-3.5" />
                </a>
              )}
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
              {detail.isLoading && (
                <p className="flex items-center gap-2 py-8 text-xs text-muted-foreground">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  Fetching SKILL.md from GitHub…
                </p>
              )}
              {detail.isError && (
                <p className="py-8 text-xs text-destructive">
                  {(detail.error as Error).message}
                </p>
              )}
              {detail.data && (
                <>
                  {detail.data.description && (
                    <p className="mb-3 text-xs text-muted-foreground">
                      {detail.data.description}
                    </p>
                  )}
                  <div className="rounded-lg border border-border/50 bg-muted/20 p-3">
                    <MarkdownReport>{detail.data.body}</MarkdownReport>
                  </div>
                </>
              )}
            </div>
            <div className="border-t border-border/60 px-4 py-3">
              <div className="flex items-center justify-end gap-2">
                <Button variant="outline" onClick={() => setSelected(null)}>
                  Back
                </Button>
                <Button
                  onClick={() => install.mutate(selected.id)}
                  disabled={
                    install.isPending ||
                    !detail.data ||
                    isInstalled(detail.data.name)
                  }
                  className="gap-1.5"
                >
                  {install.isPending ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Download className="h-3.5 w-3.5" />
                  )}
                  {detail.data && isInstalled(detail.data.name)
                    ? "Installed"
                    : "Install"}
                </Button>
              </div>
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
