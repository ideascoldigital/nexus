"use client";

// Over a project chat's composer: the project's apps running on this Mac
// (spec 39). They run detached, so they are still here after a reload or a
// restart of Nexus — this is where you see that, open one's output in a
// terminal, follow its URL, stop it, or start it again once it ended.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ExternalLink, Loader2, RotateCcw, Square, SquareTerminal } from "lucide-react";

import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import { openExternal } from "@/services/updates";

export type LocalProcessView = {
  id: string;
  repo: string;
  label: string;
  command: string;
  logPath: string;
  startedAt: string;
  stoppedAt?: string;
  running: boolean;
  url: string | null;
};

const json = { "content-type": "application/json" };

export function useLocalProcesses(projectId: string | null) {
  return useQuery({
    queryKey: ["local-processes", projectId],
    queryFn: async () => {
      const res = await fetch(`/api/projects/${projectId}/local-processes`);
      return res.ok ? ((await res.json()) as LocalProcessView[]) : [];
    },
    enabled: Boolean(projectId),
    refetchInterval: (q) => ((q.state.data ?? []).some((p) => p.running) ? 3000 : 10_000),
  });
}

/** Start commands on this Mac; resolves with the processes started. */
export async function startLocalProcesses(
  projectId: string,
  commands: { repo: string; command: string; label: string }[],
): Promise<LocalProcessView[]> {
  const started: LocalProcessView[] = [];
  for (const c of commands) {
    const res = await fetch(`/api/projects/${projectId}/local-processes`, { method: "POST", headers: json, body: JSON.stringify(c) });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`${c.label}: ${typeof body.error === "string" ? body.error : "could not start"}`);
    started.push({ ...(body as LocalProcessView), running: true, url: null });
  }
  return started;
}

/** A terminal command that shows a process's output live (Ctrl-C leaves the view, not the app). */
export const tailCommand = (logPath: string) => `tail -n 400 -F '${logPath.replace(/'/g, `'\\''`)}'`;

export function LocalProcessesStrip({
  projectId,
  onOpen,
}: {
  projectId: string;
  /** Show its output in a panel terminal. */
  onOpen: (proc: LocalProcessView) => void;
}) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const list = useLocalProcesses(projectId);
  const refresh = () => qc.invalidateQueries({ queryKey: ["local-processes", projectId] });
  const stop = useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(`/api/projects/${projectId}/local-processes/${id}`, { method: "DELETE", headers: json, body: "{}" });
      if (!res.ok) throw new Error("Could not stop it");
    },
    onSettled: refresh,
    onError: (err) => toast({ title: (err as Error).message, variant: "destructive" }),
  });
  const restart = useMutation({
    mutationFn: (p: LocalProcessView) => startLocalProcesses(projectId, [{ repo: p.repo, command: p.command, label: p.label }]),
    onSuccess: (started) => {
      refresh();
      if (started[0]) onOpen(started[0]);
    },
    onError: (err) => toast({ title: "Could not start it again", description: (err as Error).message, variant: "destructive" }),
  });

  const procs = list.data ?? [];
  if (!procs.length) return null;
  const icon = "flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground";

  return (
    <div className="mb-2 flex flex-wrap gap-1.5">
      {procs.map((p) => {
        const crashed = !p.running && !p.stoppedAt;
        return (
          <div
            key={p.id}
            className="flex max-w-full animate-in items-center gap-2 rounded-xl border border-border bg-card/70 py-1 pr-1 pl-2.5 duration-300 fade-in"
            title={`${p.command}\n${p.running ? "Running" : crashed ? "Ended on its own" : "Stopped"}`}
          >
            <span className="relative flex h-2 w-2 shrink-0">
              {p.running && <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-50" />}
              <span className={cn("relative inline-flex h-2 w-2 rounded-full", p.running ? "bg-emerald-400" : crashed ? "bg-destructive" : "bg-muted-foreground/50")} />
            </span>
            <span className={cn("text-[12.5px] font-medium", !p.running && "text-muted-foreground")}>{p.label}</span>
            {p.running && p.url ? (
              <button
                type="button"
                onClick={() => void openExternal(p.url!)}
                className="flex items-center gap-1 font-mono text-[11px] text-violet-300 hover:text-violet-200"
              >
                {p.url.replace(/^https?:\/\//, "")}
                <ExternalLink className="h-3 w-3" />
              </button>
            ) : (
              !p.running && <span className="text-[11px] text-muted-foreground">{crashed ? "ended" : "stopped"}</span>
            )}
            <span className="flex items-center">
              <button type="button" onClick={() => onOpen(p)} className={icon} aria-label={`Show ${p.label}'s output`} title="Show its output in a terminal">
                <SquareTerminal className="h-3.5 w-3.5" />
              </button>
              {p.running ? (
                <button
                  type="button"
                  onClick={() => stop.mutate(p.id)}
                  disabled={stop.isPending && stop.variables === p.id}
                  className={cn(icon, "hover:text-destructive")}
                  aria-label={`Stop ${p.label}`}
                  title="Stop"
                >
                  {stop.isPending && stop.variables === p.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <Square className="h-3 w-3 fill-current" />}
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => restart.mutate(p)}
                  disabled={restart.isPending}
                  className={icon}
                  aria-label={`Start ${p.label} again`}
                  title="Start it again"
                >
                  <RotateCcw className="h-3.5 w-3.5" />
                </button>
              )}
            </span>
          </div>
        );
      })}
    </div>
  );
}
