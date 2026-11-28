"use client";

// The composer's model picker: which Claude a bot runs on and how hard it
// thinks (claude --model / --effort), saved on the bot and used from its next
// message. Models on the left (search, ⌘1–4), reasoning on the right.

import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Check, Search } from "lucide-react";
import { siClaude } from "simple-icons";

import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useToast } from "@/hooks/use-toast";
import { CLAUDE_MODELS, EFFORTS, effortLabel, modelShortLabel, searchModels } from "@/lib/claude-models";
import { cn } from "@/lib/utils";
import { updateBot } from "@/services/bots";

function ClaudeMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={cn("shrink-0", className)} fill={`#${siClaude.hex}`} aria-hidden>
      <path d={siClaude.path} />
    </svg>
  );
}

export function ModelPicker({ bot }: { bot: { id: string; model: string | null; effort: string | null } }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  // Shown at once; the server catches up.
  const [local, setLocal] = useState<{ model: string | null; effort: string | null } | null>(null);
  const model = local ? local.model : bot.model;
  const effort = local ? local.effort : bot.effort;

  const save = useMutation({
    mutationFn: (next: { model?: string | null; effort?: string | null }) => updateBot(bot.id, next),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["bots"] });
      qc.invalidateQueries({ queryKey: ["bot-feed", bot.id] });
    },
    onError: (err) => {
      setLocal(null);
      toast({ title: "Could not change the model", description: (err as Error).message, variant: "destructive" });
    },
  });
  const pick = (next: { model?: string | null; effort?: string | null }) => {
    setLocal({ model: next.model !== undefined ? next.model : model, effort: next.effort !== undefined ? next.effort : effort });
    save.mutate(next);
  };

  // ⌘1–4 pick a model while the picker is open.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      const n = Number(e.key);
      if (n >= 1 && n <= CLAUDE_MODELS.length) {
        e.preventDefault();
        pick({ model: CLAUDE_MODELS[n - 1]!.id });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const { models, custom } = searchModels(query);
  const effortName = effortLabel(effort);
  const row =
    "flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-[13px] transition-colors hover:bg-accent/70";

  return (
    <Popover open={open} onOpenChange={(o) => (setOpen(o), o || setQuery(""))}>
      <PopoverTrigger
        render={
          <button
            type="button"
            title="Model and reasoning"
            className="flex h-8 items-center gap-1.5 rounded-full px-2.5 text-[12.5px] transition-colors hover:bg-accent"
          />
        }
      >
        <ClaudeMark className="h-3.5 w-3.5" />
        <span className="font-medium text-foreground">{modelShortLabel(model)}</span>
        {effortName && <span className="text-muted-foreground">{effortName}</span>}
      </PopoverTrigger>
      <PopoverContent side="top" align="end" sideOffset={8} className="w-[min(560px,calc(100vw-2rem))] gap-0 rounded-xl p-0">
        <div className="flex min-h-[260px]">
          {/* Models */}
          <div className="flex min-w-0 flex-1 flex-col border-r border-border p-2">
            <label className="mb-1.5 flex items-center gap-2 border-b border-border px-2 pb-2">
              <Search className="h-3.5 w-3.5 text-muted-foreground" />
              <input
                autoFocus
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    const first = models[0]?.id ?? custom;
                    if (first) pick({ model: first });
                  }
                }}
                placeholder="Search models…"
                className="min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-muted-foreground"
              />
            </label>
            {models.map((m) => {
              const i = CLAUDE_MODELS.findIndex((x) => x.id === m.id);
              return (
                <button key={m.id} type="button" onClick={() => pick({ model: m.id })} className={row}>
                  <ClaudeMark className="h-4 w-4" />
                  <span className="flex-1 truncate">{m.label}</span>
                  {model === m.id && <Check className="h-3.5 w-3.5 text-muted-foreground" />}
                  <kbd className="rounded bg-muted px-1.5 text-[10px] text-muted-foreground">⌘{i + 1}</kbd>
                </button>
              );
            })}
            {custom && (
              <button type="button" onClick={() => pick({ model: custom })} className={row}>
                <ClaudeMark className="h-4 w-4" />
                <span className="flex-1 truncate">
                  Use <span className="font-mono">{custom}</span>
                </span>
              </button>
            )}
            {!query && (
              <button type="button" onClick={() => pick({ model: null })} className={cn(row, "text-muted-foreground")}>
                <span className="h-4 w-4" />
                <span className="flex-1">Claude Code&apos;s default</span>
                {!model && <Check className="h-3.5 w-3.5" />}
              </button>
            )}
            {!models.length && !custom && <p className="px-2.5 py-2 text-[12px] text-muted-foreground">No model matches.</p>}
          </div>

          {/* Reasoning */}
          <div className="flex w-[190px] shrink-0 flex-col p-2">
            <div className="mb-1.5 flex items-baseline justify-between border-b border-border px-2 pb-2 text-[12.5px] text-muted-foreground">
              <span>Reasoning</span>
              <span className="text-[11px]">{modelShortLabel(model)}</span>
            </div>
            {EFFORTS.map((e) => (
              <button key={e.id} type="button" onClick={() => pick({ effort: e.id })} className={row}>
                <span className="flex-1">{e.label}</span>
                {effort === e.id && <Check className="h-3.5 w-3.5 text-muted-foreground" />}
              </button>
            ))}
            <button type="button" onClick={() => pick({ effort: null })} className={cn(row, "text-muted-foreground")}>
              <span className="flex-1">Default</span>
              {!effort && <Check className="h-3.5 w-3.5" />}
            </button>
          </div>
        </div>
        <p className="border-t border-border px-3 py-2 text-[11px] text-muted-foreground">Applies from the next message.</p>
      </PopoverContent>
    </Popover>
  );
}
