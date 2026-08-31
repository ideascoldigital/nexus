"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { formatDistanceToNow } from "date-fns";
import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  Database,
  ChevronRight,
  GitPullRequest,
  Loader2,
  Rocket,
  Server,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { AutoScrollLog } from "@/components/ui/auto-scroll-log";
import { SandboxSetupSheet } from "@/components/projects/project-sandboxes";
import { getSandboxes, parseStackServices } from "@/services/sandbox";
import { getTask, getTasks, runTask, type TaskSummary } from "@/services/tasks";

type Props = {
  projectId: string;
  feature: { id: string; title: string; description: string | null };
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

const ACTIVE = ["queued", "running"];

export function RunOnSandboxDialog({
  projectId,
  feature,
  open,
  onOpenChange,
}: Props) {
  const qc = useQueryClient();
  const { toast } = useToast();

  const [sandboxId, setSandboxId] = useState<string>("");
  const [extraInstructions, setExtraInstructions] = useState("");
  const [configOpen, setConfigOpen] = useState(false);

  const sandboxes = useQuery({
    queryKey: ["sandboxes", projectId],
    queryFn: () => getSandboxes(projectId),
    enabled: open,
  });

  const tasks = useQuery({
    queryKey: ["tasks", projectId, feature.id],
    queryFn: () => getTasks(projectId, feature.id),
    enabled: open,
    refetchInterval: (query) =>
      query.state.data?.some((t) => ACTIVE.includes(t.status)) ? 3000 : false,
  });

  const running = (sandboxes.data ?? []).filter((s) => s.status === "running");
  const selected = sandboxId || running[0]?.id || "";

  const mutation = useMutation({
    mutationFn: () =>
      runTask(projectId, {
        sandboxId: selected,
        featureId: feature.id,
        prompt: extraInstructions.trim() || undefined,
      }),
    onSuccess: () => {
      setExtraInstructions("");
      qc.invalidateQueries({ queryKey: ["tasks", projectId, feature.id] });
      toast({
        title: "Task sent",
        description: "Claude Code is working on it in the sandbox.",
      });
    },
  });

  // M1 — Launch & Run: the buttons open the sandbox settings sheet (same UI
  // as the Sandboxes tab); its launch button saves the config, provisions a
  // sandbox and dispatches the task when it's ready. Errors surface inside
  // the sheet's footer, so no toast on failure here.
  const launchAndRun = async () => {
    await runTask(projectId, {
      launch: true,
      featureId: feature.id,
      prompt: extraInstructions.trim() || undefined,
    });
    setExtraInstructions("");
    setConfigOpen(false);
    qc.invalidateQueries({ queryKey: ["sandboxes", projectId] });
    qc.invalidateQueries({ queryKey: ["tasks", projectId, feature.id] });
    toast({
      title: "Sandbox launching",
      description:
        "Provisioning the instance — the task dispatches automatically once it's bootstrapped.",
    });
  };

  const busy = (tasks.data ?? []).some(
    (t) => ACTIVE.includes(t.status) && t.sandboxId === selected,
  );

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        {/* grid-rows + overflow-hidden keep the header/footer fixed and scroll the
          body; min-w-0 stops long log lines from widening the dialog. */}
        <DialogContent className="sm:max-w-2xl max-h-[85vh] grid-rows-[auto_1fr_auto] overflow-hidden">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Rocket className="h-4 w-4 text-orange-400" />
              Run on sandbox
            </DialogTitle>
            <DialogDescription>
              Claude Code runs headlessly in the sandbox&apos;s repo checkout
              with this feature as the task. It edits files and runs tests there
              — your local working copy is untouched.
            </DialogDescription>
          </DialogHeader>

          <div className="min-w-0 space-y-4 overflow-y-auto py-2">
            <div className="rounded-md border border-border/50 bg-muted/20 p-3">
              <p className="text-sm font-medium">{feature.title}</p>
              {feature.description && (
                <p className="mt-1 text-xs text-muted-foreground line-clamp-3">
                  {feature.description}
                </p>
              )}
            </div>

            {running.length === 0 ? (
              <div className="space-y-3 rounded-md border border-border/50 bg-muted/20 p-3">
                <p className="flex items-center gap-2 text-xs text-amber-300/90">
                  <AlertCircle className="h-3.5 w-3.5 shrink-0" />
                  No sandbox running.
                </p>
                <p className="text-xs text-muted-foreground">
                  Launch &amp; Run opens the sandbox configuration (provider,
                  region, size, stack services…) to review or adjust it before
                  launching — the task dispatches itself as soon as the
                  bootstrap finishes.
                </p>
                {(sandboxes.data ?? []).some(
                  (s) => s.status === "provisioning",
                ) && (
                  <p className="flex items-center gap-2 text-xs text-primary">
                    <Loader2 className="h-3 w-3 animate-spin" />
                    A sandbox is already provisioning — the task can wait
                    for it, or launch another.
                  </p>
                )}
                <div className="grid gap-1.5">
                  <Label htmlFor="launch-extra">
                    Custom prompt (optional — replaces the feature-derived one)
                  </Label>
                  <Textarea
                    id="launch-extra"
                    value={extraInstructions}
                    onChange={(e) => setExtraInstructions(e.target.value)}
                    placeholder="Leave empty to use the feature's title + description as the task."
                    rows={3}
                    className="text-xs"
                  />
                </div>
                <div className="flex justify-end">
                  <Button
                    size="sm"
                    onClick={() => setConfigOpen(true)}
                    className="gap-1.5"
                  >
                    Launch &amp; Run
                  </Button>
                </div>
              </div>
            ) : (
              <>
                <div className="grid gap-1.5">
                  <Label>Sandbox</Label>
                  <Select
                    value={selected}
                    onValueChange={(v) => v && setSandboxId(v)}
                  >
                    <SelectTrigger className="w-full">
                      {/* Base UI renders the raw value unless given children. */}
                      <SelectValue>
                        {(value) => {
                          const s = running.find((r) => r.id === value);
                          return s ? `${s.name} (${s.publicIp})` : "Select…";
                        }}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      {running.map((s) => (
                        <SelectItem key={s.id} value={s.id}>
                          <span className="flex items-center gap-2">
                            <Server className="h-3.5 w-3.5" />
                            {s.name} ({s.publicIp})
                          </span>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {(() => {
                    const services = parseStackServices(
                      running.find((r) => r.id === selected)?.stackServices,
                    );
                    return services.length > 0 ? (
                      <p className="flex items-center gap-1.5 text-[10px] text-sky-300">
                        <Database className="h-3 w-3" />
                        Services: {services.map((s) => s.name).join(", ")}
                      </p>
                    ) : (
                      <p className="text-[10px] text-muted-foreground">
                        No stack services on this sandbox.
                      </p>
                    );
                  })()}
                </div>

                <div className="grid gap-1.5">
                  <Label htmlFor="extra">
                    Custom prompt (optional — replaces the feature-derived one)
                  </Label>
                  <Textarea
                    id="extra"
                    value={extraInstructions}
                    onChange={(e) => setExtraInstructions(e.target.value)}
                    placeholder="Leave empty to use the feature's title + description as the task."
                    rows={3}
                    className="text-xs"
                  />
                </div>

                {/* Busy sandbox (or just wanting isolation)? Launch a fresh one
                  from here — same flow as the empty state. */}
                <div className="flex items-center justify-between rounded-md border border-border/40 bg-muted/10 px-3 py-2">
                  <p className="text-[11px] text-muted-foreground">
                    Or launch a fresh instance — review the configuration
                    (region, size, stack) before launching; the task
                    dispatches itself once the bootstrap finishes. It bills
                    until destroyed.
                  </p>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setConfigOpen(true)}
                    disabled={mutation.isPending}
                    className="ml-3 shrink-0 gap-1.5"
                  >
                    New sandbox &amp; run
                  </Button>
                </div>
              </>
            )}

            {mutation.isError && (
              <p className="text-xs text-destructive">
                {(mutation.error as Error).message}
              </p>
            )}

            {(tasks.data?.length ?? 0) > 0 && (
              <>
                <Separator />
                <div className="space-y-2">
                  <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Runs for this feature
                  </p>
                  {/* No own scroll — the dialog body scrolls; only the log
                      keeps an inner one (it auto-follows). */}
                  <div className="min-w-0 space-y-2">
                    {tasks.data!.map((t) => (
                      <TaskRow key={t.id} projectId={projectId} task={t} />
                    ))}
                  </div>
                </div>
              </>
            )}
          </div>

          <DialogFooter>
            <Button
              onClick={() => mutation.mutate()}
              disabled={
                mutation.isPending || !selected || running.length === 0 || busy
              }
              className="gap-1.5"
              title={
                busy ? "This sandbox is already running a task" : undefined
              }
            >
              {mutation.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              {busy ? "Sandbox busy…" : "Send to sandbox"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Same config UI as the Sandboxes tab; its launch button saves the
          config and then provisions + dispatches this feature's task. */}
      <SandboxSetupSheet
        projectId={projectId}
        open={configOpen}
        onOpenChange={setConfigOpen}
        launchOverride={{ label: "Launch & Run", action: launchAndRun }}
      />
    </>
  );
}

const TASK_STATUS_STYLES: Record<string, string> = {
  queued: "border-border bg-muted/30 text-muted-foreground",
  running: "border-amber-500/20 bg-amber-500/10 text-amber-300",
  completed: "border-emerald-500/20 bg-emerald-500/10 text-emerald-300",
  error: "border-red-500/20 bg-red-500/10 text-red-300",
};

function TaskRow({
  projectId,
  task,
}: {
  projectId: string;
  task: TaskSummary;
}) {
  const [expanded, setExpanded] = useState(false);
  const active = ACTIVE.includes(task.status);

  const detail = useQuery({
    queryKey: ["task", projectId, task.id],
    queryFn: () => getTask(projectId, task.id),
    enabled: expanded,
    refetchInterval: expanded && active ? 3000 : false,
  });

  return (
    <div className="min-w-0 rounded-md border border-border/50 bg-muted/20">
      <div className="flex min-w-0 flex-wrap items-center gap-2 px-3 py-2">
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="text-muted-foreground hover:text-foreground"
          aria-label={expanded ? "Hide output" : "Show output"}
        >
          {expanded ? (
            <ChevronDown className="h-3.5 w-3.5" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5" />
          )}
        </button>
        <span
          className={`flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] ${
            TASK_STATUS_STYLES[task.status] ?? TASK_STATUS_STYLES.queued
          }`}
        >
          {active && <Loader2 className="h-2.5 w-2.5 animate-spin" />}
          {task.status === "completed" && (
            <CheckCircle2 className="h-2.5 w-2.5" />
          )}
          {active && task.phase ? `${task.status}: ${task.phase}` : task.status}
        </span>
        {task.prUrl && (
          <a
            href={task.prUrl}
            target="_blank"
            rel="noreferrer"
            className="flex items-center gap-1 rounded-full border border-violet-500/20 bg-violet-500/10 px-2 py-0.5 text-[10px] text-violet-300 hover:bg-violet-500/20"
          >
            <GitPullRequest className="h-2.5 w-2.5" />
            View PR
          </a>
        )}
        <a
          href={`/projects/${projectId}?tab=sandboxes`}
          className="flex items-center gap-1 text-[10px] font-mono text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
          title="Open this sandbox in the Sandboxes tab"
        >
          <Server className="h-2.5 w-2.5" />
          {task.sandbox.name}
        </a>
        {task.costUsd != null && (
          <Badge variant="outline" className="text-[10px]">
            ${task.costUsd.toFixed(4)}
          </Badge>
        )}
        {task.durationMs != null && (
          <span className="text-[10px] text-muted-foreground">
            {(task.durationMs / 1000).toFixed(1)}s
          </span>
        )}
        <span className="ml-auto text-[10px] text-muted-foreground">
          {formatDistanceToNow(new Date(task.createdAt), { addSuffix: true })}
        </span>
      </div>

      {task.error && (
        <p className="px-3 pb-2 text-xs break-words text-destructive">
          {task.error}
        </p>
      )}

      {expanded && (
        <div className="min-w-0 border-t border-border/40 px-3 py-2">
          {detail.isLoading && (
            <p className="text-[11px] text-muted-foreground">Loading output…</p>
          )}
          {detail.data?.result && (
            <div className="mb-2">
              <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                Result
              </p>
              <p className="text-xs break-words whitespace-pre-wrap">
                {detail.data.result}
              </p>
            </div>
          )}
          {detail.data?.log && (
            <>
              <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                Log
              </p>
              <AutoScrollLog text={detail.data.log} className="max-h-48 p-0" />
            </>
          )}
        </div>
      )}
    </div>
  );
}
