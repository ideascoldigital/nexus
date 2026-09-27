"use client";

// The global assistant (spec 30 phase 2): a panel on every page. It talks to
// /api/assistant/threads — reads run inside a turn, writes come back as
// action cards the user runs or cancels. The page's project travels with each
// message as context, shown as a chip the user can drop.

import { useEffect, useMemo, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Check,
  ChevronDown,
  Eye,
  Loader2,
  MessageSquarePlus,
  Play,
  Sparkles,
  Trash2,
  Wrench,
  X,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { MarkdownReport } from "@/components/ui/markdown-report";
import { Textarea } from "@/components/ui/textarea";
import { getProject } from "@/services/projects";
import {
  cancelAssistantWatch,
  createAssistantThread,
  decideAssistantAction,
  deleteAssistantThread,
  getAssistantThread,
  listAssistantThreads,
  streamApproveAction,
  streamAssistantMessage,
  type AssistantAction,
  type AssistantEvent,
  type AssistantThread,
} from "@/services/assistant";

const THREAD_KEY = "nexux:assistant:thread";

/** Ask the shell to open the assistant (a button far from AppShell). */
export const OPEN_ASSISTANT_EVENT = "nexux:open-assistant";

function readStoredThread(): string | null {
  try {
    return localStorage.getItem(THREAD_KEY);
  } catch {
    return null;
  }
}
function storeThread(id: string | null) {
  try {
    if (id) localStorage.setItem(THREAD_KEY, id);
    else localStorage.removeItem(THREAD_KEY);
  } catch {
    // private window — the thread just is not remembered
  }
}

/** The project a dashboard path is about, if any. */
export function projectIdFromPath(pathname: string | null): string | null {
  return pathname?.match(/^\/projects\/([^/?#]+)/)?.[1] ?? null;
}

export function AssistantPanel({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const pathname = usePathname();
  const routeProjectId = projectIdFromPath(pathname);
  // The chip can be dropped; it comes back when the page changes.
  const [contextDropped, setContextDropped] = useState(false);
  useEffect(() => {
    setContextDropped(false);
  }, [routeProjectId]);
  const contextProjectId = contextDropped ? null : routeProjectId;
  const contextProject = useQuery({
    queryKey: ["project", contextProjectId],
    queryFn: () => getProject(contextProjectId!),
    enabled: !!contextProjectId,
  });

  const [threadId, setThreadIdState] = useState<string | null>(null);
  useEffect(() => {
    setThreadIdState(readStoredThread());
  }, []);
  const setThreadId = (id: string | null) => {
    storeThread(id);
    setThreadIdState(id);
  };

  const threads = useQuery({ queryKey: ["assistant-threads"], queryFn: listAssistantThreads });
  const thread = useQuery({
    queryKey: ["assistant-thread", threadId],
    queryFn: () => getAssistantThread(threadId!),
    enabled: !!threadId,
    retry: false,
    // A watch report lands in the thread from the server's side; while one is
    // open, look for it. Nothing to wait for → no polling.
    refetchInterval: (q) => ((q.state.data?.watches?.length ?? 0) > 0 ? 4000 : false),
  });
  // A remembered thread that was deleted elsewhere: start fresh.
  useEffect(() => {
    if (thread.isError) setThreadId(null);
  }, [thread.isError]);

  const [draft, setDraft] = useState("");
  const [sentText, setSentText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const setThread = (t: AssistantThread) => {
    qc.setQueryData(["assistant-thread", t.id], t);
    void qc.invalidateQueries({ queryKey: ["assistant-threads"] });
  };
  // Each step as the server stores it — the thread grows while the turn runs.
  const appendEvent = (id: string) => (event: AssistantEvent) => {
    if (event.kind === "user") setSentText(null);
    qc.setQueryData<AssistantThread>(["assistant-thread", id], (prev) =>
      prev && !prev.events.some((e) => e.id === event.id) ? { ...prev, events: [...prev.events, event] } : prev,
    );
  };

  const send = useMutation({
    mutationFn: async (message: string) => {
      let id = threadId;
      if (!id) {
        const created = await createAssistantThread(contextProjectId);
        id = created.id;
        qc.setQueryData<AssistantThread>(["assistant-thread", id], { ...created, events: [], actions: [], watches: [] });
        setThreadId(id);
      }
      return streamAssistantMessage(id, message, contextProjectId, appendEvent(id));
    },
    onMutate: (message) => {
      setError(null);
      setSentText(message);
      setDraft("");
    },
    onSuccess: setThread,
    onError: (err: Error, message) => {
      setError(err.message);
      setDraft(message);
    },
    onSettled: () => setSentText(null),
  });

  const decide = useMutation({
    mutationFn: ({ actionId, decision }: { actionId: string; decision: "approve" | "cancel" }) =>
      decision === "approve"
        ? streamApproveAction(threadId!, actionId, appendEvent(threadId!))
        : decideAssistantAction(threadId!, actionId, decision),
    onMutate: () => setError(null),
    onSuccess: (t) => {
      setThread(t);
      // A write changed something the rest of the app shows.
      void qc.invalidateQueries({ queryKey: ["sandboxes"] });
      void qc.invalidateQueries({ queryKey: ["activity"] });
    },
    onError: (err: Error) => setError(err.message),
  });

  const unwatch = useMutation({
    mutationFn: (watchId: string) => cancelAssistantWatch(threadId!, watchId),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["assistant-thread", threadId] }),
  });

  const remove = useMutation({
    mutationFn: (id: string) => deleteAssistantThread(id),
    onSuccess: (_d, id) => {
      if (id === threadId) setThreadId(null);
      void qc.invalidateQueries({ queryKey: ["assistant-threads"] });
    },
  });

  const events = thread.data?.events ?? [];
  const actions = useMemo(() => new Map((thread.data?.actions ?? []).map((a) => [a.id, a])), [thread.data]);
  const pending = (thread.data?.actions ?? []).some((a) => a.status === "pending" || a.status === "running");
  const busy = send.isPending || decide.isPending;

  const endRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [events.length, sentText, busy]);

  const submit = () => {
    const text = draft.trim();
    if (!text || busy || pending) return;
    send.mutate(text);
  };

  const current = threads.data?.find((t) => t.id === threadId);

  return (
    <aside className="fixed inset-0 z-50 flex flex-col border-l bg-background md:static md:z-auto md:w-[420px] md:shrink-0">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b px-3">
        <Sparkles className="h-4 w-4 shrink-0 text-primary" />
        <DropdownMenu>
          <DropdownMenuTrigger className="flex min-w-0 flex-1 items-center gap-1 text-left text-sm font-medium">
            <span className="truncate">{current?.title ?? (threadId ? "Conversation" : "New conversation")}</span>
            <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-80">
            <DropdownMenuItem onClick={() => setThreadId(null)}>
              <MessageSquarePlus className="mr-2 h-4 w-4" /> New conversation
            </DropdownMenuItem>
            {(threads.data?.length ?? 0) > 0 && <DropdownMenuSeparator />}
            {threads.data?.slice(0, 20).map((t) => (
              <DropdownMenuItem key={t.id} onClick={() => setThreadId(t.id)} className="gap-2">
                <span className="min-w-0 flex-1 truncate">{t.title ?? "Untitled"}</span>
                {t.id === threadId && <Check className="h-3.5 w-3.5 shrink-0" />}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        {threadId && (
          <Button
            variant="ghost"
            size="icon-sm"
            title="Delete this conversation"
            disabled={remove.isPending}
            onClick={() => remove.mutate(threadId)}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        )}
        <Button variant="ghost" size="icon-sm" title="Close (⌘I)" onClick={onClose}>
          <X className="h-4 w-4" />
        </Button>
      </header>

      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-3 py-3 text-sm">
        {!threadId && !sentText && (
          <div className="space-y-2 pt-6 text-center text-muted-foreground">
            <p className="font-medium text-foreground">What should Nexus do?</p>
            <p className="text-xs">
              Ask about your projects, sandboxes and tasks, or have it launch a sandbox, start a task, validate a
              stack. Anything that changes something asks you first.
            </p>
          </div>
        )}
        <Transcript
          events={events}
          actions={actions}
          deciding={decide.isPending ? decide.variables?.actionId ?? null : null}
          onDecide={(actionId, decision) => decide.mutate({ actionId, decision })}
          busy={busy}
        />
        {sentText && <UserBubble text={sentText} />}
        {busy && (
          <p className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> {decide.isPending ? "Running…" : "Thinking…"}
          </p>
        )}
        {error && <p className="text-xs text-destructive">{error}</p>}
        <div ref={endRef} />
      </div>

      <footer className="shrink-0 space-y-2 border-t p-3">
        {(thread.data?.watches?.length ?? 0) > 0 && (
          <div className="space-y-1">
            {thread.data!.watches.map((w) => (
              <div key={w.id} className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <Eye className="h-3 w-3 shrink-0 text-primary" />
                <span className="min-w-0 flex-1 truncate">
                  Watching {w.kind} <span className="font-mono">{w.targetId.slice(0, 12)}</span> until{" "}
                  {w.until.replace("_", " ")}
                </span>
                <button
                  type="button"
                  title="Stop watching"
                  className="hover:text-foreground"
                  disabled={unwatch.isPending}
                  onClick={() => unwatch.mutate(w.id)}
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            ))}
          </div>
        )}
        {contextProjectId && (
          <span className="inline-flex max-w-full items-center gap-1 rounded-full border bg-muted/40 px-2 py-0.5 text-xs">
            <span className="truncate">Project: {contextProject.data?.name ?? "…"}</span>
            <button
              type="button"
              title="Don't send this page's project"
              className="text-muted-foreground hover:text-foreground"
              onClick={() => setContextDropped(true)}
            >
              <X className="h-3 w-3" />
            </button>
          </span>
        )}
        <Textarea
          value={draft}
          rows={3}
          placeholder={pending ? "Run or cancel the action above first" : "Ask or tell Nexus… (Enter to send)"}
          disabled={pending}
          className="resize-none text-sm"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
        />
      </footer>
    </aside>
  );
}

function UserBubble({ text }: { text: string }) {
  return (
    <div className="flex justify-end">
      <p className="max-w-[85%] whitespace-pre-wrap rounded-lg bg-primary/10 px-3 py-2">{text}</p>
    </div>
  );
}

function Transcript({
  events,
  actions,
  deciding,
  onDecide,
  busy,
}: {
  events: AssistantEvent[];
  actions: Map<string, AssistantAction>;
  deciding: string | null;
  onDecide: (actionId: string, decision: "approve" | "cancel") => void;
  busy: boolean;
}) {
  const items: React.ReactNode[] = [];
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    if (e.kind === "user") items.push(<UserBubble key={e.id} text={e.content.text} />);
    else if (e.kind === "assistant")
      items.push(
        <div key={e.id} className="prose-sm max-w-none">
          <MarkdownReport>{e.content.text}</MarkdownReport>
        </div>,
      );
    else if (e.kind === "watch_report")
      // The raw report is for the model; the reply after it is for the user.
      items.push(
        <p key={e.id} className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <Eye className="h-3 w-3" /> Update on {e.content.tool} {String(e.content.args?.id ?? "").slice(0, 12)}
        </p>,
      );
    else if (e.kind === "tool_call") {
      // A read and its result, folded together.
      const next = events[i + 1];
      const result = next?.kind === "tool_result" && !next.content.actionId ? next : null;
      if (result) i++;
      items.push(<ToolStep key={e.id} call={e} result={result} />);
    } else if (e.kind === "action" && e.content.actionId) {
      const action = actions.get(e.content.actionId);
      if (action)
        items.push(
          <ActionCard
            key={e.id}
            action={action}
            deciding={deciding === action.id}
            disabled={busy}
            onDecide={(d) => onDecide(action.id, d)}
          />,
        );
    } else if (e.kind === "error")
      items.push(
        <p key={e.id} className="rounded border border-destructive/40 bg-destructive/5 px-2 py-1 text-xs text-destructive">
          {e.content.text}
        </p>,
      );
    // tool_result for an action is shown on its card.
  }
  return <>{items}</>;
}

function ToolStep({ call, result }: { call: AssistantEvent; result: AssistantEvent | null }) {
  const args = call.content.args && Object.keys(call.content.args).length ? JSON.stringify(call.content.args) : "";
  return (
    <details className="group rounded-md border bg-muted/20 text-xs">
      <summary className="flex cursor-pointer list-none items-center gap-1.5 px-2 py-1 text-muted-foreground">
        <Wrench className="h-3 w-3 shrink-0" />
        <span className="font-mono">{call.content.tool}</span>
        {args && <span className="truncate font-mono opacity-70">{args}</span>}
      </summary>
      {result && (
        <pre className="max-h-48 overflow-auto whitespace-pre-wrap border-t px-2 py-1 font-mono text-[11px]">
          {JSON.stringify(result.content.result, null, 2)}
        </pre>
      )}
    </details>
  );
}

const STATUS_LABEL: Record<AssistantAction["status"], string> = {
  pending: "Waiting for you",
  running: "Running…",
  done: "Done",
  failed: "Failed",
  cancelled: "Cancelled",
};

function ActionCard({
  action,
  deciding,
  disabled,
  onDecide,
}: {
  action: AssistantAction;
  deciding: boolean;
  disabled: boolean;
  onDecide: (decision: "approve" | "cancel") => void;
}) {
  const error =
    action.result && typeof action.result === "object" && "error" in (action.result as Record<string, unknown>)
      ? String((action.result as Record<string, unknown>).error)
      : null;
  return (
    <div
      className={`space-y-2 rounded-md border p-2.5 ${
        action.status === "pending" ? "border-amber-500/50 bg-amber-500/5" : "bg-muted/20"
      }`}
    >
      <div className="flex items-start gap-2">
        <Play className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-500" />
        <div className="min-w-0 flex-1">
          <p className="text-sm">{action.summary}</p>
          <p className="font-mono text-[11px] text-muted-foreground">{action.tool}</p>
        </div>
        <span
          className={`shrink-0 text-[11px] ${
            action.status === "failed" ? "text-destructive" : action.status === "done" ? "text-emerald-500" : "text-muted-foreground"
          }`}
        >
          {STATUS_LABEL[action.status]}
        </span>
      </div>
      {error && <p className="text-xs text-destructive">{error}</p>}
      {action.status === "pending" && (
        <div className="flex gap-2">
          <Button size="sm" className="h-7 gap-1 px-3 text-xs" disabled={disabled} onClick={() => onDecide("approve")}>
            {deciding ? <Loader2 className="h-3 w-3 animate-spin" /> : <Play className="h-3 w-3" />} Run
          </Button>
          <Button size="sm" variant="ghost" className="h-7 px-3 text-xs" disabled={disabled} onClick={() => onDecide("cancel")}>
            Cancel
          </Button>
        </div>
      )}
    </div>
  );
}
