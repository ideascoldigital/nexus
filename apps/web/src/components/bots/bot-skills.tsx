"use client";

// The chat's "/" menu and the /skills dialog (spec 38). Loaded skills go into
// the bot's computer before its next message; Claude Code picks them up by
// itself, and "/<skill>" asks for one by name.

import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, Loader2, Search, Sparkles, Wand2 } from "lucide-react";

import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/hooks/use-toast";
import type { SlashOption } from "@/lib/bot-skills";
import { cn } from "@/lib/utils";
import { getBotSkills, installBotSkill, setBotSkills, type BotSkill } from "@/services/bots";

export const botSkillsKey = (botId: string) => ["bot-skills", botId] as const;

export function useBotSkills(botId: string) {
  return useQuery({
    queryKey: botSkillsKey(botId),
    queryFn: () => getBotSkills(botId).then((r) => r.skills),
    staleTime: 30_000,
  });
}

/** The menu above the composer while a "/command" is being typed. */
export function SlashMenu({
  options,
  active,
  onHover,
  onPick,
}: {
  options: SlashOption[];
  active: number;
  onHover: (i: number) => void;
  onPick: (o: SlashOption) => void;
}) {
  if (options.length === 0) return null;
  return (
    <div
      role="listbox"
      aria-label="Commands"
      className="absolute right-0 bottom-full left-0 z-20 mb-2 max-h-72 overflow-y-auto rounded-2xl border border-border bg-popover p-1.5 shadow-lg"
    >
      {options.map((o, i) => (
        <button
          key={`${o.kind}:${o.command}`}
          type="button"
          role="option"
          aria-selected={i === active}
          onMouseEnter={() => onHover(i)}
          // Keep the focus in the textarea, so typing goes on.
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => onPick(o)}
          className={cn(
            "flex w-full items-center gap-2.5 rounded-xl px-2.5 py-1.5 text-left",
            i === active ? "bg-accent" : "hover:bg-accent/60",
          )}
        >
          {o.kind === "skills" ? (
            <Sparkles className="h-4 w-4 shrink-0 text-muted-foreground" />
          ) : (
            <Wand2 className="h-4 w-4 shrink-0 text-muted-foreground" />
          )}
          <span className="shrink-0 font-mono text-[12.5px]">/{o.command}</span>
          <span className="min-w-0 truncate text-[12px] text-muted-foreground">{o.description}</span>
        </button>
      ))}
    </div>
  );
}

type RegistrySkill = { id: string; name: string; installs: number; source: string };

function useDebounced(value: string, ms: number) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

const fmt = (n: number) => (n >= 1_000_000 ? `${(n / 1e6).toFixed(1)}M` : n >= 1_000 ? `${(n / 1e3).toFixed(1)}k` : String(n));

/** /skills: switch library skills on and off for this bot, or install one from skills.sh. */
export function BotSkillsDialog({
  botId,
  botName,
  open,
  onOpenChange,
}: {
  botId: string;
  botName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [tab, setTab] = useState<"library" | "install">("library");
  const [filter, setFilter] = useState("");
  const [query, setQuery] = useState("");
  const debounced = useDebounced(query.trim(), 300);

  const skills = useBotSkills(botId);
  const done = (r: { skills: BotSkill[] }) => {
    qc.setQueryData(botSkillsKey(botId), r.skills);
    qc.invalidateQueries({ queryKey: ["skills"] });
  };
  const failed = (title: string) => (err: unknown) =>
    toast({ title, description: err instanceof Error ? err.message : undefined, variant: "destructive" });

  const toggle = useMutation({
    mutationFn: (s: BotSkill) => {
      const on = new Set((skills.data ?? []).filter((x) => x.loaded).map((x) => x.id));
      if (s.loaded) on.delete(s.id);
      else on.add(s.id);
      return setBotSkills(botId, [...on]);
    },
    onSuccess: done,
    onError: failed("Could not change the skills"),
  });
  const install = useMutation({
    mutationFn: (id: string) => installBotSkill(botId, id),
    onSuccess: (r, id) => {
      done(r);
      const name = id.split("/").pop();
      toast({
        title: `${botName} has “${name}”`,
        description: `It uses it when a task fits. To ask for it now, type /${name} in the chat.`,
      });
    },
    onError: failed("Could not install the skill"),
  });

  const results = useQuery({
    queryKey: ["skills-registry", debounced],
    queryFn: async () => {
      const res = await fetch(`/api/skills/registry?q=${encodeURIComponent(debounced)}`);
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Search failed");
      return body.skills as RegistrySkill[];
    },
    enabled: open && tab === "install" && debounced.length >= 2,
    staleTime: 60_000,
  });

  const list = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const all = [...(skills.data ?? [])].sort((a, b) => Number(b.loaded) - Number(a.loaded) || a.name.localeCompare(b.name));
    return q ? all.filter((s) => `${s.name} ${s.description ?? ""}`.toLowerCase().includes(q)) : all;
  }, [skills.data, filter]);
  const names = new Set((skills.data ?? []).map((s) => s.name.toLowerCase()));
  const loadedCount = (skills.data ?? []).filter((s) => s.loaded).length;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[80vh] flex-col gap-3 sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{botName}&apos;s skills</DialogTitle>
          <DialogDescription>
            Loaded skills go into its computer before its next message, and it uses them when they fit. Type
            “/name” in the chat to ask for one.
          </DialogDescription>
        </DialogHeader>
        <div className="flex gap-1 rounded-full bg-muted p-0.5 text-[12.5px]">
          {(
            [
              ["library", `Library${loadedCount ? ` · ${loadedCount} loaded` : ""}`],
              ["install", "Install from skills.sh"],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              onClick={() => setTab(id)}
              className={cn(
                "flex-1 rounded-full px-3 py-1",
                tab === id ? "bg-background font-medium shadow-sm" : "text-muted-foreground",
              )}
            >
              {label}
            </button>
          ))}
        </div>

        {tab === "library" ? (
          <>
            <div className="relative">
              <Search className="absolute top-1/2 left-2.5 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter skills" className="pl-8" />
            </div>
            <div className="-mx-1 min-h-0 flex-1 overflow-y-auto px-1">
              {skills.isLoading && <Loader2 className="mx-auto my-6 h-4 w-4 animate-spin text-muted-foreground" />}
              {skills.data && list.length === 0 && (
                <p className="py-6 text-center text-[12.5px] text-muted-foreground">
                  {filter ? "No skill matches." : "The library is empty — install one from skills.sh."}
                </p>
              )}
              {list.map((s) => (
                <label
                  key={s.id}
                  className="flex cursor-pointer items-start gap-3 rounded-lg px-2 py-2 hover:bg-accent/50"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block font-mono text-[12.5px]">{s.name}</span>
                    {s.description && (
                      <span className="line-clamp-2 block text-[12px] text-muted-foreground">{s.description}</span>
                    )}
                  </span>
                  <Switch
                    checked={s.loaded}
                    disabled={toggle.isPending}
                    onCheckedChange={() => toggle.mutate(s)}
                    aria-label={`Load ${s.name}`}
                    className="mt-0.5"
                  />
                </label>
              ))}
            </div>
          </>
        ) : (
          <>
            <div className="relative">
              <Search className="absolute top-1/2 left-2.5 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                autoFocus
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search skills.sh — pdf, frontend, testing…"
                className="pl-8"
              />
            </div>
            <div className="-mx-1 min-h-0 flex-1 overflow-y-auto px-1">
              {debounced.length < 2 && (
                <p className="py-6 text-center text-[12.5px] text-muted-foreground">Type at least two letters.</p>
              )}
              {results.isFetching && <Loader2 className="mx-auto my-6 h-4 w-4 animate-spin text-muted-foreground" />}
              {results.error && (
                <p className="py-6 text-center text-[12.5px] text-destructive">{(results.error as Error).message}</p>
              )}
              {results.data?.length === 0 && (
                <p className="py-6 text-center text-[12.5px] text-muted-foreground">Nothing found.</p>
              )}
              {results.data?.map((r) => {
                const have = names.has(r.name.toLowerCase());
                const busy = install.isPending && install.variables === r.id;
                return (
                  <div key={r.id} className="flex items-center gap-3 rounded-lg px-2 py-2 hover:bg-accent/50">
                    <span className="min-w-0 flex-1">
                      <span className="block font-mono text-[12.5px]">{r.name}</span>
                      <span className="block truncate text-[11.5px] text-muted-foreground">
                        {r.source} · {fmt(r.installs)} installs
                      </span>
                    </span>
                    <button
                      type="button"
                      disabled={install.isPending}
                      onClick={() => install.mutate(r.id)}
                      className="flex shrink-0 items-center gap-1.5 rounded-full border border-border px-2.5 py-1 text-[12px] hover:bg-accent disabled:opacity-50"
                    >
                      {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Download className="h-3 w-3" />}
                      {have ? "Load" : "Install & load"}
                    </button>
                  </div>
                );
              })}
            </div>
            <p className="text-[11.5px] text-muted-foreground">
              Installed skills join this workspace&apos;s library, so other bots and projects can use them too. Read a
              skill before loading it: the bot follows what it says.
            </p>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
