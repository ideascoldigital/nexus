"use client";

// Run the project on this Mac, as plain processes (spec 39). The chat has no
// shell, so it proposes the commands here; a tap starts each one detached, in
// its repository's folder, and shows its output in a panel terminal. The
// strip over the composer lists them, to open or stop.

import { useState } from "react";
import { Check, Play, SquareTerminal } from "lucide-react";

import type { RunCommand } from "@/lib/nexus-cards";
import { cn } from "@/lib/utils";

export function RunCard({
  commands,
  color,
  onRun,
}: {
  commands: RunCommand[];
  color: string;
  onRun: (commands: RunCommand[]) => void;
}) {
  const [started, setStarted] = useState<Set<number>>(new Set());
  const run = (idx: number[]) => {
    onRun(idx.map((i) => commands[i]!));
    setStarted((s) => new Set([...s, ...idx]));
  };
  const all = commands.map((_, i) => i);
  const allStarted = all.every((i) => started.has(i));

  return (
    <div className="w-full max-w-[560px] rounded-2xl border border-border bg-card px-4 pt-3.5 pb-3">
      <div className="flex items-center gap-2 pb-2.5">
        <SquareTerminal className="h-4 w-4 text-muted-foreground" />
        <p className="flex-1 text-[13.5px] font-semibold">Run on this Mac</p>
        {commands.length > 1 && (
          <button
            type="button"
            onClick={() => run(all)}
            disabled={allStarted}
            className="flex h-7 items-center gap-1.5 rounded-full px-3 text-[12px] font-medium text-white transition-opacity disabled:opacity-40"
            style={{ background: color }}
          >
            <Play className="h-3 w-3 fill-current" />
            Run all
          </button>
        )}
      </div>
      <ul className="space-y-1.5">
        {commands.map((c, i) => (
          <li key={`${c.repo}-${i}`} className="flex items-center gap-3 rounded-xl border border-border/70 bg-background/40 py-2 pr-2 pl-3">
            <div className="min-w-0 flex-1">
              <p className="truncate text-[12.5px] font-medium">
                {c.label}
                {c.label !== c.repo && <span className="font-normal text-muted-foreground"> · {c.repo}</span>}
              </p>
              <code className="block truncate font-mono text-[11.5px] text-muted-foreground">{c.command}</code>
            </div>
            <button
              type="button"
              onClick={() => run([i])}
              className={cn(
                "flex h-7 shrink-0 items-center gap-1.5 rounded-full border px-2.5 text-[12px] transition-colors",
                started.has(i)
                  ? "border-emerald-500/30 text-emerald-300"
                  : "border-border text-foreground hover:bg-accent",
              )}
              title={started.has(i) ? "Started — run again to restart it" : "Run on this Mac"}
            >
              {started.has(i) ? <Check className="h-3 w-3" /> : <Play className="h-3 w-3 fill-current" />}
              {started.has(i) ? "Running" : "Run"}
            </button>
          </li>
        ))}
      </ul>
      <p className="mt-2.5 text-[11px] text-muted-foreground">Each runs in its repository&apos;s folder and keeps running after a reload — see, open or stop it from the bar above the chat.</p>
    </div>
  );
}
