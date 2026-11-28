"use client";

// Above a project chat's composer while its sandbox is being set up (spec 39):
// the bot's dots, "Setting up the sandbox", the step it is on and how long it
// has taken, and a way to the full setup log. Gone once it runs (the chat
// says so); a failure stays, in red, until the next launch.

import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, ScrollText } from "lucide-react";

import { WorkingDots } from "@/components/bots/run-indicator";
import { elapsedLabel, sandboxPhase } from "@/lib/sandbox-phase";
import type { SandboxSummary } from "@/services/sandbox";

export function SandboxStatusBar({
  projectId,
  sandbox,
  color,
  onOpenLog,
}: {
  projectId: string;
  sandbox: SandboxSummary;
  color: string;
  onOpenLog: () => void;
}) {
  const booting = sandbox.status === "provisioning" || sandbox.status === "pending";
  // Same queries (and keys) as the panel's Setup log, so both share one poll.
  const provisioning = useQuery({
    queryKey: ["sandbox-row-log", sandbox.id],
    queryFn: async () => {
      const res = await fetch(`/api/projects/${projectId}/sandboxes/${sandbox.id}`);
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Could not read the sandbox");
      return (body.log as string) ?? "";
    },
    refetchInterval: booting ? 3000 : false,
  });
  const bootstrap = useQuery({
    queryKey: ["sandbox-bootstrap-log", sandbox.id],
    queryFn: async () => {
      const res = await fetch(`/api/projects/${projectId}/sandboxes/${sandbox.id}/bootstrap-log`);
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Could not read the setup log");
      return body as { log: string; complete: boolean; failed: boolean };
    },
    enabled: booting && /bootstrap started|bootstrap complete/.test(provisioning.data ?? ""),
    refetchInterval: (q) => (q.state.data?.complete || q.state.data?.failed ? false : 4000),
    retry: false,
  });

  // A ticking clock while it boots.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!booting) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [booting]);

  // A failure is news for a while, not forever.
  const failed = sandbox.status === "error" && now - new Date(sandbox.updatedAt).getTime() < 30 * 60_000;
  if (!booting && !failed) return null;
  const phase = sandboxPhase(provisioning.data, bootstrap.data?.log);

  return (
    <div className="mb-2 flex animate-in items-center gap-2.5 rounded-xl border border-border bg-card/70 px-3 py-2 duration-300 fade-in slide-in-from-bottom-1">
      {failed ? (
        <AlertTriangle className="h-4 w-4 shrink-0 text-destructive" />
      ) : (
        <WorkingDots color={color} />
      )}
      <div className="flex min-w-0 flex-1 items-baseline gap-1.5 text-[12.5px]">
        {failed ? (
          <span className="shrink-0 font-medium text-destructive">The sandbox failed</span>
        ) : (
          <span className="nexux-shimmer shrink-0 font-medium">Setting up the sandbox</span>
        )}
        <span className="truncate text-muted-foreground">
          {failed ? (sandbox.error ? `· ${sandbox.error}` : "") : phase ? `· ${phase}` : ""}
        </span>
      </div>
      {!failed && (
        <span className="shrink-0 font-mono text-[11px] text-muted-foreground tabular-nums">{elapsedLabel(sandbox.createdAt, now)}</span>
      )}
      <button
        type="button"
        onClick={onOpenLog}
        className="flex h-7 shrink-0 items-center gap-1.5 rounded-full px-2.5 text-[12px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
      >
        <ScrollText className="h-3.5 w-3.5" />
        Setup log
      </button>
    </div>
  );
}
