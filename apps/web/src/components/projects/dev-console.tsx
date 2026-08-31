"use client";

// Dev console for a dedicated sandbox: a chat-style feed of prompts against
// the sandbox's continuous Claude session. No PR ceremony — the user drives
// git. Prompts sent while one is running queue up and run in order.

import { memo, useCallback, useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { formatDistanceToNow } from "date-fns";
import {
  Bell,
  BellOff,
  CircleHelp,
  FileText,
  GitPullRequest,
  ImageIcon,
  Loader2,
  MessageSquareCode,
  Paperclip,
  Square,
  X,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { MarkdownReport } from "@/components/ui/markdown-report";
import { TaskScreenshots } from "@/components/projects/task-screenshots";
import { prLabel } from "@/components/features/feature-card";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import {
  cancelDevPrompt,
  getDevFeed,
  resetDevSession,
  sendDevPrompt,
  updateSandbox,
  type DevTask,
  type SandboxSummary,
} from "@/services/sandbox";

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function AttachmentChip({
  name,
  mime,
  size,
  onRemove,
}: {
  name: string;
  mime: string;
  size: number;
  onRemove?: () => void;
}) {
  const Icon = mime.startsWith("image/") ? ImageIcon : FileText;
  return (
    <span className="inline-flex max-w-56 items-center gap-1.5 rounded-md border border-border/60 bg-muted/40 px-2 py-1 text-[10px]">
      <Icon className="h-3 w-3 shrink-0 text-muted-foreground" />
      <span className="truncate">{name}</span>
      <span className="shrink-0 text-muted-foreground">{formatBytes(size)}</span>
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          className="shrink-0 text-muted-foreground hover:text-destructive"
          title="Remove attachment"
        >
          <X className="h-3 w-3" />
        </button>
      )}
    </span>
  );
}

function formatDuration(ms: number | null): string {
  if (!ms) return "";
  const min = Math.floor(ms / 60_000);
  const sec = Math.round((ms % 60_000) / 1000);
  return min > 0 ? `${min}m ${sec}s` : `${sec}s`;
}

/**
 * One exchange in the feed.
 *
 * Memoised because the composer's state lives in the same component as this
 * list: every keystroke re-rendered the parent, and each bubble re-parsed its
 * markdown from scratch. On a long conversation of agent reports that is the
 * whole typing lag. The memo only holds if the props are stable, which is why
 * `onCancel` takes the id instead of being a closure built per row.
 */
const DevTaskBubble = memo(function DevTaskBubble({
  projectId,
  task,
  onCancel,
  canceling,
}: {
  projectId: string;
  task: DevTask;
  onCancel: (taskId: string) => void;
  canceling: boolean;
}) {
  const needsInput = task.phase === "needs_input";
  return (
    <div className="space-y-1.5">
      {/* The user's prompt */}
      <div className="ml-auto w-fit max-w-[85%] space-y-1.5 rounded-lg rounded-br-sm bg-primary/15 px-3 py-2 text-xs whitespace-pre-wrap">
        {task.prompt}
        {(task.attachments?.length ?? 0) > 0 && (
          <div className="flex flex-wrap justify-end gap-1">
            {task.attachments!.map((a, i) => (
              <AttachmentChip key={i} name={a.name} mime={a.mime} size={a.size} />
            ))}
          </div>
        )}
      </div>
      {/* Claude's side */}
      {task.status === "queued" && (
        <div className="flex w-fit max-w-[85%] items-center gap-2 rounded-lg border border-dashed border-border/70 px-3 py-2 text-[11px] text-muted-foreground">
          Queued — waiting for the previous prompt
          <button
            type="button"
            onClick={() => onCancel(task.id)}
            disabled={canceling}
            className="text-muted-foreground hover:text-destructive"
            title="Cancel this prompt"
          >
            <X className="h-3 w-3" />
          </button>
        </div>
      )}
      {task.status === "running" && (
        <div className="w-fit max-w-[92%] space-y-1.5 rounded-lg border border-border/70 px-3 py-2">
          <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
            <Loader2 className="h-3 w-3 animate-spin" />
            Claude is working…
            <button
              type="button"
              onClick={() => onCancel(task.id)}
              disabled={canceling}
              className="ml-1 inline-flex items-center gap-1 rounded border border-border/60 px-1.5 py-0.5 text-[10px] text-muted-foreground transition-colors hover:border-destructive/50 hover:text-destructive disabled:opacity-50"
              title="Stop this run"
            >
              <Square className="h-2.5 w-2.5 fill-current" />
              Stop
            </button>
          </div>
          {task.logTail && (
            <pre className="max-h-32 overflow-y-auto font-mono text-[10px] leading-snug whitespace-pre-wrap break-all text-muted-foreground/80">
              {task.logTail}
            </pre>
          )}
        </div>
      )}
      {task.status === "canceled" && (
        <div className="w-fit rounded-lg border border-border/50 px-3 py-1.5 text-[11px] text-muted-foreground line-through">
          Canceled
        </div>
      )}
      {task.status === "error" && (
        <div className="w-fit max-w-[85%] rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-[11px] text-destructive">
          {task.error ?? "The run failed"}
        </div>
      )}
      {task.status === "completed" && (
        <div
          className={`w-fit max-w-[92%] rounded-lg rounded-bl-sm border px-3 py-2 ${
            needsInput
              ? "border-amber-400/50 bg-amber-400/10"
              : "border-border/70 bg-muted/30"
          }`}
        >
          {needsInput && (
            <div className="mb-1.5 flex items-center gap-1.5 text-[11px] font-medium text-amber-300">
              <CircleHelp className="h-3.5 w-3.5" />
              Claude needs your input
            </div>
          )}
          {task.result ? (
            <MarkdownReport>{task.result}</MarkdownReport>
          ) : (
            <span className="text-[11px] text-muted-foreground">Done.</span>
          )}
          {/* Images the agent saved for this prompt — same ones Telegram gets. */}
          <TaskScreenshots projectId={projectId} taskId={task.id} />
          <div className="mt-1.5 flex items-center gap-2 text-[10px] text-muted-foreground">
            {task.prUrl && (
              <a
                href={task.prUrl}
                target="_blank"
                rel="noreferrer"
                title={task.prUrl}
                className="flex items-center gap-1 rounded-full border border-violet-500/20 bg-violet-500/10 px-2 py-0.5 text-violet-300 transition-colors hover:bg-violet-500/20"
              >
                <GitPullRequest className="h-2.5 w-2.5" />
                {prLabel(task.prUrl)}
              </a>
            )}
            <span>
              {[
                formatDuration(task.durationMs),
                task.costUsd ? `$${task.costUsd.toFixed(2)}` : "",
                task.finishedAt
                  ? formatDistanceToNow(new Date(task.finishedAt), {
                      addSuffix: true,
                    })
                  : "",
              ]
                .filter(Boolean)
                .join(" · ")}
            </span>
          </div>
        </div>
      )}
    </div>
  );
});

export function DevConsoleSheet({
  projectId,
  sandbox,
  open,
  onOpenChange,
}: {
  projectId: string;
  sandbox: SandboxSummary;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [prompt, setPrompt] = useState("");
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);
  const feedRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const addFiles = (incoming: File[]) => {
    if (incoming.length === 0) return;
    setPendingFiles((prev) => [...prev, ...incoming].slice(0, 10));
  };

  const feedKey = ["dev-console", sandbox.id];
  const { data: feed } = useQuery({
    queryKey: feedKey,
    queryFn: () => getDevFeed(projectId, sandbox.id),
    enabled: open,
    // Live-ish: a prompt in flight streams its status through the task row.
    refetchInterval: open ? 3000 : false,
  });

  const busy = feed?.tasks.some(
    (t) => t.status === "queued" || t.status === "running",
  );

  // Keep the feed pinned to the newest message.
  const lastCount = useRef(0);
  useEffect(() => {
    const el = feedRef.current;
    if (!el) return;
    const count = feed?.tasks.length ?? 0;
    const lastStatus = feed?.tasks[feed.tasks.length - 1]?.status;
    if (count !== lastCount.current || lastStatus === "running") {
      lastCount.current = count;
      el.scrollTop = el.scrollHeight;
    }
  }, [feed]);

  // On open, land at the newest message (the rAF waits for the sheet's
  // content to be laid out). Focus goes to the composer via `initialFocus`.
  useEffect(() => {
    if (!open) return;
    const id = requestAnimationFrame(() => {
      const el = feedRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    });
    return () => cancelAnimationFrame(id);
  }, [open]);

  const send = useMutation({
    mutationFn: (input: { text: string; files: File[] }) =>
      sendDevPrompt(projectId, sandbox.id, input.text, input.files),
    onSuccess: () => {
      setPrompt("");
      setPendingFiles([]);
      qc.invalidateQueries({ queryKey: feedKey });
    },
    onError: (err) =>
      toast({
        title: "Could not send prompt",
        description: err instanceof Error ? err.message : undefined,
        variant: "destructive",
      }),
  });

  const cancel = useMutation({
    mutationFn: (taskId: string) =>
      cancelDevPrompt(projectId, sandbox.id, taskId),
    onSuccess: () => qc.invalidateQueries({ queryKey: feedKey }),
  });
  // Stable across renders so the memoised bubbles actually skip: an inline
  // `() => cancel.mutate(t.id)` is a new identity on every keystroke, which
  // defeats the memo entirely and re-parses every message's markdown.
  const cancelMutate = cancel.mutate;
  const cancelTask = useCallback(
    (taskId: string) => cancelMutate(taskId),
    [cancelMutate],
  );

  const reset = useMutation({
    mutationFn: () => resetDevSession(projectId, sandbox.id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: feedKey });
      toast({
        title: "Session reset",
        description:
          "History cleared — the next prompt starts a fresh Claude session.",
      });
    },
  });

  const toggleMute = useMutation({
    mutationFn: (patch: { muteTelegram?: boolean; muteSlack?: boolean }) =>
      updateSandbox(projectId, sandbox.id, patch),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: feedKey });
      qc.invalidateQueries({ queryKey: ["sandboxes", projectId] });
    },
  });

  const muted = feed?.muteTelegram ?? sandbox.muteTelegram;
  const mutedSlack = feed?.muteSlack ?? sandbox.muteSlack;

  const submit = () => {
    const text = prompt.trim();
    if (!text || send.isPending) return;
    send.mutate({ text, files: pendingFiles });
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="flex w-full flex-col gap-0 p-0 data-[side=right]:sm:max-w-3xl"
        // Cursor lands in the composer, ready to type.
        initialFocus={textareaRef}
      >
        <SheetHeader className="border-b border-border/60 px-4 py-3">
          <SheetTitle className="flex items-center gap-2 text-sm">
            <MessageSquareCode className="h-4 w-4 text-primary" />
            Dev console
            <code className="text-[11px] font-normal text-muted-foreground">
              {sandbox.name}
            </code>
            {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          </SheetTitle>
          <SheetDescription className="sr-only">
            Chat-style prompts against this sandbox&apos;s continuous Claude
            session.
          </SheetDescription>
          <div className="flex flex-wrap items-center gap-3 pt-1">
            <Badge variant="outline" className="text-[10px]">
              {feed?.hasSession ? "continuous session" : "no session yet"}
            </Badge>
            <Button
              size="sm"
              variant="ghost"
              className="h-6 gap-1 px-2 text-[11px]"
              onClick={() => reset.mutate()}
              disabled={
                reset.isPending ||
                (!feed?.hasSession && (feed?.tasks.length ?? 0) === 0)
              }
              title="Forget the Claude session and clear the chat history — the next prompt starts cold"
            >
              Reset session
            </Button>
            <label className="ml-auto flex items-center gap-1.5 text-[11px] text-muted-foreground">
              {muted ? (
                <BellOff className="h-3.5 w-3.5" />
              ) : (
                <Bell className="h-3.5 w-3.5 text-primary" />
              )}
              Telegram
              <Switch
                checked={!muted}
                onCheckedChange={(on) => toggleMute.mutate({ muteTelegram: !on })}
                disabled={toggleMute.isPending}
                aria-label="Toggle Telegram notifications for this sandbox"
              />
            </label>
            <label className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
              {mutedSlack ? (
                <BellOff className="h-3.5 w-3.5" />
              ) : (
                <Bell className="h-3.5 w-3.5 text-primary" />
              )}
              Slack
              <Switch
                checked={!mutedSlack}
                onCheckedChange={(on) => toggleMute.mutate({ muteSlack: !on })}
                disabled={toggleMute.isPending}
                aria-label="Toggle Slack notifications for this sandbox"
              />
            </label>
          </div>
        </SheetHeader>

        <div
          ref={feedRef}
          className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4"
        >
          {feed && feed.tasks.length === 0 && (
            <p className="pt-10 text-center text-xs text-muted-foreground">
              Send the first prompt — Claude works directly in the sandbox
              checkout. Nothing is committed or pushed unless you ask for it.
            </p>
          )}
          {feed?.tasks.map((t) => (
            <DevTaskBubble
              key={t.id}
              projectId={projectId}
              task={t}
              onCancel={cancelTask}
              canceling={cancel.isPending}
            />
          ))}
        </div>

        <div className="border-t border-border/60 p-3">
          {pendingFiles.length > 0 && (
            <div className="mb-2 flex flex-wrap gap-1">
              {pendingFiles.map((f, i) => (
                <AttachmentChip
                  key={`${f.name}-${i}`}
                  name={f.name}
                  mime={f.type}
                  size={f.size}
                  onRemove={() =>
                    setPendingFiles((prev) => prev.filter((_, j) => j !== i))
                  }
                />
              ))}
            </div>
          )}
          <div className="flex items-end gap-2">
            <input
              ref={fileInputRef}
              type="file"
              multiple
              className="hidden"
              onChange={(e) => {
                addFiles(Array.from(e.target.files ?? []));
                e.target.value = ""; // allow re-picking the same file
              }}
            />
            <Button
              size="icon-sm"
              variant="ghost"
              onClick={() => fileInputRef.current?.click()}
              title="Attach images or documents"
              className="shrink-0"
            >
              <Paperclip className="h-4 w-4" />
            </Button>
            <Textarea
              ref={textareaRef}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onPaste={(e) => {
                // Pasted screenshots/files attach instead of being dropped.
                const files = Array.from(e.clipboardData.files ?? []);
                if (files.length > 0) {
                  e.preventDefault();
                  addFiles(files);
                }
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  submit();
                }
              }}
              placeholder={
                busy
                  ? "Claude is busy — your prompt will queue and run next…"
                  : "Tell Claude what to do in this sandbox…"
              }
              // Auto-grows with the prompt (field-sizing-content) but capped:
              // past ~7 lines it scrolls internally instead of pushing the
              // Send button out of the sheet.
              className="max-h-44 min-h-[60px] resize-none overflow-y-auto text-xs"
            />
            <Button
              size="sm"
              onClick={submit}
              disabled={!prompt.trim() || send.isPending}
              className="gap-1.5"
            >
              {send.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              Send
            </Button>
          </div>
          <p className="mt-1.5 text-[10px] text-muted-foreground">
            Enter to send · Shift+Enter for a newline · attach or paste images
            &amp; docs (max 10, 25 MB) · replies also arrive on Telegram
            {muted ? " (muted)" : ""} &amp; Slack{mutedSlack ? " (muted)" : ""}
          </p>
        </div>
      </SheetContent>
    </Sheet>
  );
}
