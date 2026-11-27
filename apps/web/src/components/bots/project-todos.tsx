"use client";

// Tasks in a project's Details (spec 39): a plain to-do list — add one, tick
// it off, and say which pull request closed it (picked from the project's
// own PRs, or a pasted link). Done ones fold away under "Completed".

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, ChevronRight, GitPullRequest, Link2, Loader2, Plus, Search, Trash2, X } from "lucide-react";

import { PR_STATE, useProjectPullRequests } from "@/components/bots/pull-requests-surface";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useToast } from "@/hooks/use-toast";
import type { PullRequest } from "@/lib/project-prs";
import { parsePrLink } from "@/lib/pr-link";
import { cn } from "@/lib/utils";
import { openExternal } from "@/services/updates";

export type ProjectTodo = { id: string; title: string; done: boolean; doneAt: string | null; prUrl: string | null; position: number };

async function json<T>(res: Response): Promise<T> {
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = (body as { error?: unknown }).error;
    throw new Error(typeof err === "string" ? err : "Request failed");
  }
  return body as T;
}

const card = "rounded-xl border border-border bg-card/60";

export function ProjectTodos({ projectId }: { projectId: string }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const key = ["project-todos", projectId];
  const todos = useQuery({
    queryKey: key,
    queryFn: async () => json<ProjectTodo[]>(await fetch(`/api/projects/${projectId}/todos`)),
  });
  const [draft, setDraft] = useState("");
  const [showDone, setShowDone] = useState(false);
  const fail = (title: string) => (err: unknown) =>
    toast({ title, description: err instanceof Error ? err.message : undefined, variant: "destructive" });

  const add = useMutation({
    mutationFn: async (title: string) =>
      json<ProjectTodo>(
        await fetch(`/api/projects/${projectId}/todos`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ title }),
        }),
      ),
    onSuccess: (todo) => {
      qc.setQueryData<ProjectTodo[]>(key, (list = []) => [...list, todo]);
      setDraft("");
    },
    onError: fail("Could not add the task"),
  });
  const patch = useMutation({
    mutationFn: async ({ id, ...body }: { id: string; title?: string; done?: boolean; prUrl?: string | null }) =>
      json<ProjectTodo>(
        await fetch(`/api/projects/${projectId}/todos/${id}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
      ),
    // Ticked at once; the server catches up.
    onMutate: ({ id, ...change }) => {
      const before = qc.getQueryData<ProjectTodo[]>(key);
      qc.setQueryData<ProjectTodo[]>(key, (list = []) =>
        list.map((t) => (t.id === id ? { ...t, ...change, ...(change.done !== undefined ? { doneAt: change.done ? new Date().toISOString() : null } : {}) } : t)),
      );
      return { before };
    },
    onError: (err, _v, ctx) => {
      qc.setQueryData(key, ctx?.before);
      fail("Could not save the task")(err);
    },
  });
  const remove = useMutation({
    mutationFn: async (id: string) => json(await fetch(`/api/projects/${projectId}/todos/${id}`, { method: "DELETE" })),
    onMutate: (id) => {
      const before = qc.getQueryData<ProjectTodo[]>(key);
      qc.setQueryData<ProjectTodo[]>(key, (list = []) => list.filter((t) => t.id !== id));
      return { before };
    },
    onError: (err, _v, ctx) => {
      qc.setQueryData(key, ctx?.before);
      fail("Could not delete the task")(err);
    },
  });

  const list = todos.data ?? [];
  const open = list.filter((t) => !t.done);
  const done = list.filter((t) => t.done).sort((a, b) => (b.doneAt ?? "").localeCompare(a.doneAt ?? ""));
  const rowProps = {
    projectId,
    onToggle: (t: ProjectTodo) => patch.mutate({ id: t.id, done: !t.done }),
    onRename: (t: ProjectTodo, title: string) => patch.mutate({ id: t.id, title }),
    onLink: (t: ProjectTodo, prUrl: string | null) => patch.mutate({ id: t.id, prUrl }),
    onDelete: (t: ProjectTodo) => remove.mutate(t.id),
  };

  return (
    <section className="space-y-2">
      <div className="flex items-center justify-between px-1">
        <h3 className="text-[12px] text-muted-foreground">
          Tasks{list.length > 0 && ` · ${done.length} of ${list.length} done`}
        </h3>
      </div>

      <div className={cn(card, "overflow-hidden")}>
        {list.length > 0 && (
          <div className="h-0.5 bg-border/50">
            <div className="h-full bg-emerald-400/70 transition-all duration-500" style={{ width: `${(done.length / list.length) * 100}%` }} />
          </div>
        )}
        <form
          className="flex items-center gap-2.5 px-3 py-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (draft.trim()) add.mutate(draft.trim());
          }}
        >
          {add.isPending ? (
            <Loader2 className="h-4 w-4 shrink-0 animate-spin text-muted-foreground" />
          ) : (
            <Plus className="h-4 w-4 shrink-0 text-muted-foreground" />
          )}
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Add a task…"
            className="h-7 min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-muted-foreground"
          />
          {draft.trim() && <kbd className="rounded bg-muted px-1.5 text-[10px] text-muted-foreground">↵</kbd>}
        </form>

        {open.length > 0 && (
          <ul className="border-t border-border/60">
            {open.map((t) => (
              <TodoRow key={t.id} todo={t} {...rowProps} />
            ))}
          </ul>
        )}

        {todos.isLoading && <p className="border-t border-border/60 px-3 py-2.5 text-[12px] text-muted-foreground">Loading…</p>}
        {!todos.isLoading && list.length === 0 && (
          <p className="border-t border-border/60 px-3 py-2.5 text-[12px] text-muted-foreground">
            Nothing yet — small things to do here, each with the PR that closes it.
          </p>
        )}
        {!todos.isLoading && list.length > 0 && open.length === 0 && (
          <p className="flex items-center gap-2 border-t border-border/60 px-3 py-2.5 text-[12px] text-muted-foreground">
            <Check className="h-3.5 w-3.5 text-emerald-400" /> All done.
          </p>
        )}

        {done.length > 0 && (
          <div className="border-t border-border/60">
            <button
              type="button"
              onClick={() => setShowDone(!showDone)}
              className="flex w-full items-center gap-1.5 px-3 py-2 text-[11.5px] text-muted-foreground hover:text-foreground"
            >
              <ChevronRight className={cn("h-3 w-3 transition-transform", showDone && "rotate-90")} />
              Completed · {done.length}
            </button>
            {showDone && (
              <ul>
                {done.map((t) => (
                  <TodoRow key={t.id} todo={t} {...rowProps} />
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
    </section>
  );
}

function TodoRow({
  todo,
  projectId,
  onToggle,
  onRename,
  onLink,
  onDelete,
}: {
  todo: ProjectTodo;
  projectId: string;
  onToggle: (t: ProjectTodo) => void;
  onRename: (t: ProjectTodo, title: string) => void;
  onLink: (t: ProjectTodo, prUrl: string | null) => void;
  onDelete: (t: ProjectTodo) => void;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const finish = () => {
    const title = editing?.trim();
    if (title && title !== todo.title) onRename(todo, title);
    setEditing(null);
  };
  return (
    <li className="group flex items-start gap-2.5 px-3 py-2 transition-colors hover:bg-accent/40">
      <button
        type="button"
        role="checkbox"
        aria-checked={todo.done}
        aria-label={todo.done ? `Mark "${todo.title}" as not done` : `Mark "${todo.title}" as done`}
        onClick={() => onToggle(todo)}
        className={cn(
          "mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border transition-colors",
          todo.done ? "border-emerald-400 bg-emerald-400 text-background" : "border-muted-foreground/50 hover:border-emerald-400",
        )}
      >
        {todo.done && <Check className="h-2.5 w-2.5" strokeWidth={3} />}
      </button>
      <div className="min-w-0 flex-1">
        {editing !== null ? (
          <input
            autoFocus
            value={editing}
            onChange={(e) => setEditing(e.target.value)}
            onBlur={finish}
            onKeyDown={(e) => {
              if (e.key === "Enter") finish();
              if (e.key === "Escape") setEditing(null);
            }}
            className="w-full bg-transparent text-[13px] leading-5 outline-none"
          />
        ) : (
          <button
            type="button"
            onDoubleClick={() => setEditing(todo.title)}
            title="Double-click to rename"
            className={cn(
              "block w-full text-left text-[13px] leading-5 break-words",
              todo.done && "text-muted-foreground line-through decoration-muted-foreground/50",
            )}
          >
            {todo.title}
          </button>
        )}
        {todo.prUrl && <PrChip projectId={projectId} url={todo.prUrl} onUnlink={() => onLink(todo, null)} />}
      </div>
      <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100">
        <PrPicker projectId={projectId} current={todo.prUrl} onPick={(url) => onLink(todo, url)} />
        <button
          type="button"
          onClick={() => onDelete(todo)}
          aria-label={`Delete "${todo.title}"`}
          title="Delete"
          className="flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-destructive"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>
    </li>
  );
}

/** The linked PR: its state when it is one of the project's, else just the link. */
function PrChip({ projectId, url, onUnlink }: { projectId: string; url: string; onUnlink: () => void }) {
  const prs = useProjectPullRequests(projectId);
  const known = prs.data?.items.find((p) => p.url === url);
  const link = parsePrLink(url);
  const state = known ? PR_STATE[known.state] : null;
  const Icon = state?.icon ?? GitPullRequest;
  return (
    <span className="mt-1 inline-flex max-w-full items-center gap-1 rounded-full border border-border bg-background/60 py-0.5 pr-1 pl-2 text-[11px]">
      <button
        type="button"
        onClick={() => void openExternal(url)}
        title={known ? `${known.title} — ${state!.label}` : url}
        className="flex min-w-0 items-center gap-1.5 hover:text-foreground"
      >
        <Icon className={cn("h-3 w-3 shrink-0", state?.tint ?? "text-muted-foreground")} />
        <span className="truncate font-mono text-muted-foreground">{known ? `${known.repo} #${known.number}` : (link?.label ?? url)}</span>
        {known && <span className="truncate text-foreground/80">{known.title}</span>}
      </button>
      <button
        type="button"
        onClick={onUnlink}
        aria-label="Unlink the pull request"
        className="rounded-full p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
      >
        <X className="h-2.5 w-2.5" />
      </button>
    </span>
  );
}

/** Pick one of the project's PRs, or paste any link. */
function PrPicker({ projectId, current, onPick }: { projectId: string; current: string | null; onPick: (url: string) => void }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const prs = useProjectPullRequests(projectId);
  const pasted = parsePrLink(query);
  const q = query.trim().toLowerCase();
  const items: PullRequest[] = (prs.data?.items ?? []).filter(
    (p) => !q || p.title.toLowerCase().includes(q) || `${p.repo} #${p.number}`.toLowerCase().includes(q),
  );
  const pick = (url: string) => {
    onPick(url);
    setOpen(false);
    setQuery("");
  };
  return (
    <Popover open={open} onOpenChange={(o) => (setOpen(o), o || setQuery(""))}>
      <PopoverTrigger
        render={
          <button
            type="button"
            aria-label="Link a pull request"
            title={current ? "Change the pull request" : "Link a pull request"}
            className="flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
          />
        }
      >
        <GitPullRequest className="h-3.5 w-3.5" />
      </PopoverTrigger>
      <PopoverContent side="bottom" align="end" sideOffset={6} className="w-[min(380px,calc(100vw-2rem))] gap-0 rounded-xl p-1.5">
        <label className="mb-1 flex items-center gap-2 border-b border-border px-2 pb-2 pt-1">
          <Search className="h-3.5 w-3.5 text-muted-foreground" />
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== "Enter") return;
              e.preventDefault();
              if (items[0]) pick(items[0].url);
              else if (pasted) pick(pasted.url);
            }}
            placeholder="Search PRs or paste a link…"
            className="min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-muted-foreground"
          />
        </label>
        <div className="max-h-64 overflow-y-auto">
          {pasted && items.length === 0 && (
            <button
              type="button"
              onClick={() => pick(pasted.url)}
              className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[12.5px] hover:bg-accent"
            >
              <Link2 className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <span className="truncate">
                Link <span className="font-mono">{pasted.label}</span>
              </span>
            </button>
          )}
          {items.map((p) => {
            const s = PR_STATE[p.state];
            return (
              <button
                key={p.url}
                type="button"
                onClick={() => pick(p.url)}
                className="flex w-full items-start gap-2 rounded-lg px-2 py-1.5 text-left hover:bg-accent"
              >
                <s.icon className={cn("mt-0.5 h-3.5 w-3.5 shrink-0", s.tint)} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[12.5px]">{p.title}</span>
                  <span className="block truncate font-mono text-[10.5px] text-muted-foreground">
                    {p.repo} #{p.number} · {s.label}
                  </span>
                </span>
                {current === p.url && <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />}
              </button>
            );
          })}
          {prs.isLoading && (
            <p className="flex items-center gap-2 px-2 py-2 text-[12px] text-muted-foreground">
              <Loader2 className="h-3 w-3 animate-spin" /> Loading the project&apos;s PRs…
            </p>
          )}
          {!prs.isLoading && items.length === 0 && !pasted && (
            <p className="px-2 py-2 text-[12px] text-muted-foreground">
              {q ? "No PR matches — paste its link instead." : "No PRs found for this project's repositories — paste a link."}
            </p>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
