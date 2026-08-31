"use client";

// aitmpl.com agent browser: search the catalog (420+ agents), preview the
// full definition and install it into the active workspace.

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

type RegistryAgent = {
  name: string;
  path: string;
  category: string;
  description: string;
  downloads: number;
};

type ResolvedAgent = {
  name: string;
  description: string;
  model: string | null;
  tools: string | null;
  systemPrompt: string;
  repoUrl: string;
};

const fmtDownloads = (n: number) =>
  n >= 1_000_000
    ? `${(n / 1_000_000).toFixed(1)}M`
    : n >= 1_000
      ? `${(n / 1_000).toFixed(1)}k`
      : String(n);

function useDebounced(value: string, ms: number) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return debounced;
}

export function AgentsRegistryBrowser({
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
  const [selected, setSelected] = useState<RegistryAgent | null>(null);
  const debounced = useDebounced(query, 300);

  const results = useQuery({
    queryKey: ["agents-registry", debounced],
    queryFn: async () => {
      const res = await fetch(
        `/api/agents/registry?q=${encodeURIComponent(debounced)}`,
      );
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Search failed");
      return body.agents as RegistryAgent[];
    },
    enabled: open,
    staleTime: 60_000,
  });

  const detail = useQuery({
    queryKey: ["agents-registry-detail", selected?.path],
    queryFn: async () => {
      const res = await fetch(
        `/api/agents/registry/resolve?path=${encodeURIComponent(selected!.path)}`,
      );
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Could not load the agent");
      return body as ResolvedAgent;
    },
    enabled: open && selected !== null,
    staleTime: 5 * 60_000,
    retry: false,
  });

  const install = useMutation({
    mutationFn: async (path: string) => {
      const res = await fetch("/api/agents/registry/install", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Install failed");
      return body;
    },
    onSuccess: (agent) => {
      qc.invalidateQueries({ queryKey: ["agents"] });
      toast({
        title: "Agent installed",
        description: `“${agent.name}” is now in this workspace — wire it to projects from Orchestrate.`,
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
            {selected ? selected.name : "Browse agents — aitmpl.com"}
          </SheetTitle>
          <SheetDescription className="text-xs">
            {selected
              ? `${selected.category} · ${selected.downloads.toLocaleString()} downloads`
              : "Claude Code Templates catalog (420+ agents) — search, preview and install into this workspace."}
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
                  placeholder="Search agents… (security, react, database)"
                  className="pl-8 text-sm"
                />
              </div>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
              {results.isLoading && (
                <p className="flex items-center gap-2 py-8 text-xs text-muted-foreground">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  Loading catalog…
                </p>
              )}
              {results.isError && (
                <p className="py-8 text-xs text-destructive">
                  {(results.error as Error).message}
                </p>
              )}
              {results.data?.length === 0 && (
                <p className="py-8 text-center text-xs text-muted-foreground">
                  No agents match “{debounced}”.
                </p>
              )}
              <div className="space-y-1.5">
                {results.data?.map((agent) => (
                  <button
                    key={agent.path}
                    type="button"
                    onClick={() => setSelected(agent)}
                    className="flex w-full items-center gap-3 rounded-lg border border-border/50 bg-muted/20 px-3 py-2.5 text-left transition-colors hover:border-border"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">
                        {agent.name}
                      </p>
                      <p className="truncate text-[10.5px] text-muted-foreground">
                        {agent.description || agent.category}
                      </p>
                    </div>
                    <Badge variant="secondary" className="shrink-0 text-[10px]">
                      {agent.category}
                    </Badge>
                    {isInstalled(agent.name) && (
                      <Badge
                        variant="outline"
                        className="shrink-0 text-[10px] text-emerald-400"
                      >
                        installed
                      </Badge>
                    )}
                    <span className="shrink-0 font-mono text-[10.5px] text-muted-foreground">
                      {fmtDownloads(agent.downloads)} installs
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
              {detail.data?.model && (
                <Badge variant="outline" className="text-[10px]">
                  model: {detail.data.model}
                </Badge>
              )}
              {detail.data && (
                <a
                  href={detail.data.repoUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="ml-auto text-muted-foreground hover:text-foreground"
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
                  Fetching the agent definition…
                </p>
              )}
              {detail.isError && (
                <p className="py-8 text-xs text-destructive">
                  {(detail.error as Error).message}
                </p>
              )}
              {detail.data && (
                <div className="rounded-lg border border-border/50 bg-muted/20 p-3">
                  <MarkdownReport>{detail.data.systemPrompt}</MarkdownReport>
                </div>
              )}
            </div>
            <div className="border-t border-border/60 px-4 py-3">
              <div className="flex items-center justify-end gap-2">
                <Button variant="outline" onClick={() => setSelected(null)}>
                  Back
                </Button>
                <Button
                  onClick={() => install.mutate(selected.path)}
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
