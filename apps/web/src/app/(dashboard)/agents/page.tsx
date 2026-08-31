"use client";

// The agent library: who you can delegate to. A hero strip says how big the
// bench is, filter pills cut it by origin, and each card carries the agent's
// own color as a hairline accent — built-ins read as fixtures, custom ones
// as yours to edit.

import { useMemo, useState } from "react";
import { AppHeader } from "@/components/layout/app-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { formatDistanceToNow } from "date-fns";
import {
  Bot,
  Lock,
  MessageSquareCode,
  Pencil,
  Plus,
  RefreshCw,
  Search,
} from "lucide-react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { getAgents, syncAgents, type AgentWithCount } from "@/services/agents";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import Link from "next/link";
import { AgentsRegistryBrowser } from "@/components/agents/agents-registry-browser";

type OriginFilter = "all" | "custom" | "built-in";

function AgentCard({ agent, index }: { agent: AgentWithCount; index: number }) {
  const editable = !agent.isBuiltIn;
  const color = agent.color || "#8e51ff";
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
      {/* The agent's own color, worn as a hairline. */}
      <span
        className="absolute top-3 bottom-3 left-0 w-0.5 rounded-full"
        style={{ backgroundColor: color }}
      />
      <CardContent className="p-5">
        <div className="flex items-start gap-3">
          <div
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg transition-transform duration-300 group-hover:scale-105"
            style={{ backgroundColor: color + "20" }}
          >
            <Bot className="h-4 w-4" style={{ color }} />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h3 className="truncate text-sm font-medium">{agent.name}</h3>
              {agent.isBuiltIn ? (
                <span
                  className="ml-auto flex shrink-0 items-center gap-1 text-[10px] text-muted-foreground"
                  title="Built-in — synced from ~/.claude/agents, not editable here"
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
              {agent.description || "No description."}
            </p>
            <div className="mt-3 flex items-center gap-2 text-[11px] text-muted-foreground">
              {agent.model && (
                <span className="rounded border border-border/60 bg-muted/40 px-1.5 py-px font-mono text-[10px]">
                  {agent.model}
                </span>
              )}
              <span
                className={cn(
                  "flex items-center gap-1",
                  agent._count.conversations > 0 && "text-foreground/80",
                )}
                title={`${agent._count.conversations} conversation${agent._count.conversations !== 1 ? "s" : ""}`}
              >
                <MessageSquareCode className="h-3 w-3" />
                {agent._count.conversations}
              </span>
              <span className="ml-auto text-[10px] text-muted-foreground/70">
                {formatDistanceToNow(new Date(agent.updatedAt), {
                  addSuffix: true,
                })}
              </span>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );

  if (!editable) return card;
  return <Link href={`/agents/${agent.id}/edit`}>{card}</Link>;
}

export default function AgentsPage() {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const [registryOpen, setRegistryOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [origin, setOrigin] = useState<OriginFilter>("all");

  const { data: agents, isLoading } = useQuery({
    queryKey: ["agents"],
    queryFn: getAgents,
  });

  const counts = useMemo(() => {
    const all = agents ?? [];
    return {
      all: all.length,
      custom: all.filter((a) => !a.isBuiltIn).length,
      "built-in": all.filter((a) => a.isBuiltIn).length,
    };
  }, [agents]);

  const filtered = useMemo(() => {
    let list = agents ?? [];
    if (origin === "custom") list = list.filter((a) => !a.isBuiltIn);
    if (origin === "built-in") list = list.filter((a) => a.isBuiltIn);
    const q = query.trim().toLowerCase();
    if (!q) return list;
    return list.filter(
      (a) =>
        a.name.toLowerCase().includes(q) ||
        (a.description ?? "").toLowerCase().includes(q) ||
        (a.model ?? "").toLowerCase().includes(q),
    );
  }, [agents, origin, query]);

  const syncMutation = useMutation({
    mutationFn: syncAgents,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["agents"] });
      toast({
        title: "Success",
        description: "Built-in agents synced successfully",
      });
    },
    onError: (error: Error) => {
      toast({
        title: "Error",
        description: error.message || "Failed to sync agents",
        variant: "destructive",
      });
    },
  });

  const filterPill = (id: OriginFilter, label: string) => (
    <button
      key={id}
      type="button"
      onClick={() => setOrigin(id)}
      className={cn(
        "flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] transition-colors",
        origin === id
          ? "border-primary/40 bg-primary/10 text-foreground"
          : "border-border/60 text-muted-foreground hover:border-border hover:text-foreground",
      )}
    >
      {label}
      <span className="font-mono text-[10px] tabular-nums text-muted-foreground">
        {counts[id]}
      </span>
    </button>
  );

  return (
    <>
      <AppHeader title="Agents" />
      <div className="flex-1 overflow-auto">
        <div className="mx-auto w-full max-w-6xl space-y-5 px-4 py-6">
          {/* ---- Hero ---------------------------------------------------- */}
          <header className="flex flex-wrap items-start justify-between gap-4 border-b border-border/60 pb-5">
            <div className="flex items-start gap-3">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-violet-500/20 bg-violet-500/10 text-violet-300">
                <Bot className="h-4.5 w-4.5" />
              </div>
              <div>
                <h1 className="text-base leading-tight font-semibold">
                  Agents
                </h1>
                <p className="mt-0.5 text-sm text-muted-foreground">
                  The specialists Claude can delegate to — installed into every
                  sandbox as native ~/.claude agents.
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
                {syncMutation.isPending ? "Syncing…" : "Sync built-in"}
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setRegistryOpen(true)}
                title="Browse and install agents from aitmpl.com (Claude Code Templates)"
              >
                Browse registry
              </Button>
              <Link href="/agents/new">
                <Button size="sm" className="gap-1.5">
                  <Plus className="h-3.5 w-3.5" />
                  New agent
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
                placeholder="Search agents by name, description or model…"
                className="h-9 pl-9 text-sm"
              />
            </div>
            <div className="flex gap-1.5">
              {filterPill("all", "All")}
              {filterPill("custom", "Custom")}
              {filterPill("built-in", "Built-in")}
            </div>
          </div>

          {/* ---- Grid ---------------------------------------------------- */}
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
          ) : (agents?.length ?? 0) === 0 ? (
            <div className="flex flex-col items-center justify-center py-20 text-center">
              <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-xl border border-violet-500/20 bg-violet-500/10">
                <Bot className="h-6 w-6 text-violet-300" />
              </div>
              <p className="mb-1 text-sm font-medium">No agents yet</p>
              <p className="mb-5 text-xs text-muted-foreground">
                Create one with AI, install from the registry, or sync the
                built-ins from ~/.claude/agents.
              </p>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => syncMutation.mutate()}
                >
                  <RefreshCw className="h-3.5 w-3.5" />
                  Sync built-in
                </Button>
                <Link href="/agents/new">
                  <Button size="sm" className="gap-1.5">
                    <Plus className="h-3.5 w-3.5" />
                    New agent
                  </Button>
                </Link>
              </div>
            </div>
          ) : filtered.length === 0 ? (
            <div className="py-12 text-center text-sm text-muted-foreground">
              Nothing matches{query.trim() ? ` "${query.trim()}"` : ""} in{" "}
              {origin === "all" ? "the library" : `${origin} agents`}.
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
              {filtered.map((agent, i) => (
                <AgentCard key={agent.id} agent={agent} index={i} />
              ))}
            </div>
          )}
        </div>
      </div>
      <AgentsRegistryBrowser
        open={registryOpen}
        onOpenChange={setRegistryOpen}
        installedNames={
          new Set((agents ?? []).map((a: { name: string }) => a.name))
        }
      />
    </>
  );
}
