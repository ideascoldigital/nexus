"use client";

// The processes running on one sandbox: a row per startable command, each with
// its own start/stop and log. Replaces the single "live preview" button for
// multi-repo projects — a web app and a functions emulator are two processes,
// not one preview.

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ChevronDown,
  ChevronRight,
  ExternalLink,
  Loader2,
  Play,
  RefreshCw,
  ScrollText,
  Square,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import {
  ApiError,
  getSandboxProcessLog,
  listSandboxProcesses,
  refreshSandboxCli,
  startSandboxProcess,
  stopSandboxProcess,
  type SandboxProcessView,
} from "@/services/sandbox";

const RUNNING = new Set(["running", "starting"]);

export function SandboxProcessPanel({
  projectId,
  sandboxId,
}: {
  projectId: string;
  sandboxId: string;
}) {
  const [open, setOpen] = useState(false);

  const { data: processes = [], isLoading } = useQuery({
    queryKey: ["sandbox-processes", projectId, sandboxId],
    queryFn: () => listSandboxProcesses(projectId, sandboxId),
    // State is reconciled against the box on every read, so a crashed dev
    // server stops showing as running without the user doing anything.
    refetchInterval: open ? 10_000 : false,
  });

  const runningCount = processes.filter((p) => RUNNING.has(p.status)).length;

  if (!isLoading && processes.length === 0) return null;

  return (
    <div className="border-t border-border/50">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full cursor-pointer items-center gap-2 px-3 py-2 text-xs text-muted-foreground transition-colors hover:text-foreground"
      >
        {open ? (
          <ChevronDown className="h-3.5 w-3.5" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5" />
        )}
        Processes
        <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px]">
          {runningCount}/{processes.length} running
        </span>
        {isLoading && <Loader2 className="h-3 w-3 animate-spin" />}
      </button>
      {open && (
        <div className="flex flex-col gap-1 px-3 pb-3">
          {processes.map((proc) => (
            <ProcessRow
              key={proc.key}
              projectId={projectId}
              sandboxId={sandboxId}
              proc={proc}
            />
          ))}
          <RefreshCliRow projectId={projectId} sandboxId={sandboxId} />
        </div>
      )}
    </div>
  );
}

/**
 * Re-sync the in-sandbox `nexus` CLI.
 *
 * The sandbox holds a snapshot of these same processes so `nexus start web`
 * works from a terminal with no route back to this database. Editing the stack
 * canvas leaves that snapshot describing commands that moved — this rewrites
 * it. Offered as a manual action rather than an automatic one: it execs into
 * the box, and a canvas edit should not silently reach into a running sandbox.
 */
function RefreshCliRow({
  projectId,
  sandboxId,
}: {
  projectId: string;
  sandboxId: string;
}) {
  const { toast } = useToast();
  const refresh = useMutation({
    mutationFn: () => refreshSandboxCli(projectId, sandboxId),
    onSuccess: (r) =>
      toast({
        title: "Terminal CLI updated",
        description: `${r.processes} process(es) and ${r.repos} project(s) — run \`nexus\` in a sandbox terminal.`,
      }),
    onError: (err) =>
      toast({
        title: "Could not update the CLI",
        description: err instanceof ApiError ? err.message : String(err),
        variant: "destructive",
      }),
  });

  return (
    <button
      type="button"
      onClick={() => refresh.mutate()}
      disabled={refresh.isPending}
      className="mt-1 flex cursor-pointer items-center gap-1.5 self-start text-[11px] text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
      title="Rewrite /opt/nexus/nexus.json so `nexus start` matches the current stack"
    >
      {refresh.isPending ? (
        <Loader2 className="h-3 w-3 animate-spin" />
      ) : (
        <RefreshCw className="h-3 w-3" />
      )}
      Sync terminal CLI
    </button>
  );
}

function statusStyle(status: string): string {
  if (status === "running") return "bg-emerald-500/10 text-emerald-300";
  if (status === "starting") return "bg-amber-500/10 text-amber-300";
  if (status === "error") return "bg-destructive/10 text-destructive";
  return "bg-muted text-muted-foreground";
}

function ProcessRow({
  projectId,
  sandboxId,
  proc,
}: {
  projectId: string;
  sandboxId: string;
  proc: SandboxProcessView;
}) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [log, setLog] = useState<string | null>(null);

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["sandbox-processes", projectId, sandboxId] });
    // The main preview pill on the sandbox row mirrors a running tunnel.
    qc.invalidateQueries({ queryKey: ["sandboxes", projectId] });
  };

  const start = useMutation({
    mutationFn: () => startSandboxProcess(projectId, sandboxId, proc.key),
    onSuccess: (data) => {
      invalidate();
      toast({
        title: `${proc.label} is up`,
        description: data.process.previewUrl ?? `Running in ${proc.cwd}`,
      });
    },
    onError: (err) => {
      invalidate();
      // The API sends the remote log tail alongside the message — without it
      // the user gets "it failed" and nothing to act on.
      const tail = err instanceof ApiError ? err.log : undefined;
      toast({
        title: `${proc.label} failed to start`,
        description: tail ? (
          <span className="flex flex-col gap-1">
            <span>{(err as Error).message}</span>
            <span className="max-h-40 overflow-auto whitespace-pre-wrap rounded bg-black/40 p-2 font-mono text-[10px] leading-tight">
              {tail}
            </span>
          </span>
        ) : (
          (err as Error).message
        ),
        variant: "destructive",
      });
    },
  });

  const stop = useMutation({
    mutationFn: () => stopSandboxProcess(projectId, sandboxId, proc.key),
    onSuccess: invalidate,
    onError: (err) =>
      toast({
        title: `Could not stop ${proc.label}`,
        description: err instanceof Error ? err.message : undefined,
        variant: "destructive",
      }),
  });

  const showLog = async () => {
    if (log !== null) {
      setLog(null);
      return;
    }
    try {
      const tail = await getSandboxProcessLog(projectId, sandboxId, proc.key);
      setLog(tail || "(the process has written nothing yet)");
    } catch (err) {
      toast({
        title: "Could not read the log",
        description: err instanceof Error ? err.message : undefined,
        variant: "destructive",
      });
    }
  };

  const busy = start.isPending || stop.isPending;
  const running = RUNNING.has(proc.status);

  return (
    <div className="rounded-md border border-border/40 bg-background/40">
      <div className="flex flex-wrap items-center gap-2 px-2 py-1.5">
        <span
          className={`rounded-full px-1.5 py-0.5 text-[10px] ${statusStyle(proc.status)}`}
        >
          {start.isPending ? "starting" : proc.status}
        </span>
        <span className="text-xs font-medium">{proc.label}</span>
        {proc.role === "services" && (
          <span
            className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground"
            title="Brings infrastructure up rather than the app itself"
          >
            services
          </span>
        )}
        <code
          className="truncate rounded bg-muted/50 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground"
          title={`${proc.command} — in ${proc.cwd}`}
        >
          {proc.command}
        </code>
        {proc.port !== null && (
          <span className="text-[10px] text-muted-foreground">:{proc.port}</span>
        )}
        {proc.source === "repo-setup" && (
          <span
            className="text-[10px] text-muted-foreground"
            title="No node on the Stack canvas — taken from the repo's run command"
          >
            repo setup
          </span>
        )}
        {proc.stale && (
          <span
            className="rounded-full bg-amber-500/10 px-1.5 py-0.5 text-[10px] text-amber-300"
            title={`Running: ${proc.command}. The canvas has changed since — restart to pick it up.`}
          >
            stale
          </span>
        )}
        <span className="ml-auto flex items-center gap-1">
          {proc.previewUrl && (
            <a
              href={proc.previewUrl}
              target="_blank"
              rel="noreferrer"
              className="flex items-center gap-1 rounded-full border border-sky-500/20 bg-sky-500/10 px-2 py-0.5 text-[10px] text-sky-300 hover:bg-sky-500/20"
              title={`Live: ${proc.previewUrl}`}
            >
              <ExternalLink className="h-2.5 w-2.5" />
              Open
            </a>
          )}
          <Button
            size="icon-sm"
            variant="ghost"
            onClick={() => void showLog()}
            aria-label="Toggle log"
            title="Toggle log"
          >
            <ScrollText className="h-3.5 w-3.5" />
          </Button>
          {running ? (
            <Button
              size="sm"
              variant="outline"
              className="h-6 gap-1 px-2 text-[10px]"
              onClick={() => stop.mutate()}
              disabled={busy}
              title={`Stop ${proc.label}`}
            >
              {stop.isPending ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <Square className="h-3 w-3" />
              )}
              Stop
            </Button>
          ) : (
            <Button
              size="sm"
              variant="outline"
              className="h-6 gap-1 px-2 text-[10px]"
              onClick={() => start.mutate()}
              disabled={busy}
              title={
                proc.port
                  ? `Start ${proc.label} and expose port ${proc.port}`
                  : `Start ${proc.label}`
              }
            >
              {start.isPending ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <Play className="h-3 w-3" />
              )}
              Start
            </Button>
          )}
        </span>
      </div>
      {proc.error && (
        <p className="px-2 pb-1.5 text-[10px] text-destructive">{proc.error}</p>
      )}
      {log !== null && (
        <pre className="max-h-64 overflow-auto whitespace-pre-wrap border-t border-border/40 bg-black/40 px-2 py-1.5 font-mono text-[10px] leading-tight">
          {log}
        </pre>
      )}
    </div>
  );
}
