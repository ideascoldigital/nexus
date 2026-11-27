"use client";

// "Details" in a project chat (spec 39) — what an assistant's Details is to
// it: everything about the project, editable in place. Its tasks (a simple
// to-do list, each with the PR that closed it), its repositories and
// folders (add a folder or a Git URL, remove one), the skills its sandboxes
// load, and where its notifications go (Telegram, Slack).

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FolderOpen, GitBranch, Loader2, Plus, Sparkles, Trash2, X } from "lucide-react";

import { BotAvatar } from "@/components/bots/bot-avatar";
import { ProjectTodos } from "@/components/bots/project-todos";
import { BrandIcon } from "@/components/ui/brand-icon";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { FolderPicker } from "@/components/projects/folder-picker";
import { useToast } from "@/hooks/use-toast";
import type { BotShape } from "@/lib/bot-shapes";
import { parseGitUrls } from "@/lib/nexus-cards";
import { cn } from "@/lib/utils";
import { getSlackStatus, getTelegramBot } from "@/services/sandbox";

type Repo = { id: string; name: string; repoUrl: string | null; localPath: string | null; isMain: boolean; cloneStatus: string };
type ProjectView = { id: string; name: string; description: string | null; workspacePath: string | null; repositories: Repo[] };
type Skill = { id: string; name: string; description: string | null };

const CLONE_DOT: Record<string, string> = {
  ready: "bg-emerald-400",
  cloning: "bg-amber-400 animate-pulse",
  pending: "bg-muted-foreground",
  error: "bg-destructive",
};

async function json<T>(res: Response): Promise<T> {
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = (body as { error?: unknown }).error;
    throw new Error(typeof err === "string" ? err : "Request failed");
  }
  return body as T;
}

/** Same section look as an assistant's Details (bot-panel.tsx). */
function Section({ title, action, children }: { title: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="space-y-2">
      <div className="flex items-center justify-between px-1">
        <h3 className="text-[12px] text-muted-foreground">{title}</h3>
        {action}
      </div>
      {children}
    </section>
  );
}

function AddButton({ open, onClick, label }: { open: boolean; onClick: () => void; label: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex items-center gap-1 text-[11.5px] text-muted-foreground hover:text-foreground"
    >
      {open ? <X className="h-3 w-3" /> : <Plus className="h-3 w-3" />}
      {open ? "Cancel" : label}
    </button>
  );
}

/** "https://git.civo.com/civo/colony/colony-api.git" → "git.civo.com/civo/colony/colony-api". */
const shortSource = (r: { repoUrl: string | null; localPath: string | null }) =>
  r.repoUrl
    ? r.repoUrl.replace(/^(https?:\/\/|ssh:\/\/|git@)/, "").replace(/\.git$/, "").replace(/^([^/:]+):/, "$1/")
    : (r.localPath ?? "—").replace(/^\/Users\/[^/]+/, "~");

const card = "rounded-xl border border-border bg-card/60";

export function ProjectDetailsPanel({
  projectId,
  bot,
  onClose,
  embedded = false,
}: {
  projectId: string;
  bot: { shape: BotShape; color: string };
  onClose?: () => void;
  /** Inside the sandbox panel's Settings surface: fills it, no close button of its own. */
  embedded?: boolean;
}) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const fail = (title: string) => (err: unknown) =>
    toast({ title, description: err instanceof Error ? err.message : undefined, variant: "destructive" });

  const project = useQuery({
    queryKey: ["project", projectId],
    queryFn: async () => json<ProjectView>(await fetch(`/api/projects/${projectId}`)),
    refetchInterval: (q) => ((q.state.data?.repositories ?? []).some((r) => r.cloneStatus === "cloning") ? 3000 : false),
  });
  const refreshProject = () => {
    qc.invalidateQueries({ queryKey: ["project", projectId] });
    qc.invalidateQueries({ queryKey: ["sandboxes", projectId] });
  };

  // ---- Repositories ----
  const [adding, setAdding] = useState<null | "menu" | "git">(null);
  const [picking, setPicking] = useState(false);
  const [gitInput, setGitInput] = useState("");
  const [removing, setRemoving] = useState<Repo | null>(null);
  const addRepo = useMutation({
    mutationFn: async (repo: { name: string; localPath?: string; repoUrl?: string }) => {
      const created = await json<{ id: string }>(
        await fetch(`/api/projects/${projectId}/repositories`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(repo),
        }),
      );
      // A Git URL has to be checked out before it is any use.
      if (repo.repoUrl && !repo.localPath) {
        void fetch(`/api/projects/${projectId}/repositories/${created.id}/clone`, { method: "POST" }).finally(refreshProject);
      }
      return created;
    },
    onSuccess: () => {
      setAdding(null);
      setGitInput("");
      refreshProject();
    },
    onError: fail("Could not add it"),
  });
  const removeRepo = useMutation({
    mutationFn: async (repo: Repo) =>
      json(await fetch(`/api/projects/${projectId}/repositories/${repo.id}`, { method: "DELETE" })),
    onSuccess: refreshProject,
    onError: fail("Could not remove it"),
  });
  const repoNameFromUrl = (url: string) => url.replace(/\.git$/, "").split(/[/:]/).filter(Boolean).pop() ?? "repo";

  // ---- Skills ----
  const loaded = useQuery({
    queryKey: ["project-skills", projectId],
    queryFn: async () => json<Skill[]>(await fetch(`/api/projects/${projectId}/skills`)),
  });
  const library = useQuery({
    queryKey: ["skills"],
    queryFn: async () => json<Skill[]>(await fetch(`/api/skills`)),
  });
  const [skillPicker, setSkillPicker] = useState(false);
  const setSkills = useMutation({
    mutationFn: async (ids: string[]) =>
      json(
        await fetch(`/api/projects/${projectId}/skills`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ skillIds: ids }),
        }),
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["project-skills", projectId] }),
    onError: fail("Could not change the skills"),
  });
  const loadedIds = new Set((loaded.data ?? []).map((s) => s.id));
  const available = (library.data ?? []).filter((s) => !loadedIds.has(s.id));

  // ---- Notifications ----
  const notif = useQuery({
    queryKey: ["project-notifications", projectId],
    queryFn: async () =>
      json<{ telegramChatId: string | null; slackChannelId: string | null }>(await fetch(`/api/projects/${projectId}/notifications`)),
  });
  const telegram = useQuery({ queryKey: ["telegram-bot"], queryFn: getTelegramBot, staleTime: 60_000 });
  const slack = useQuery({ queryKey: ["slack-status"], queryFn: getSlackStatus, staleTime: 60_000 });
  const saveNotif = useMutation({
    mutationFn: async (data: { telegramChatId?: string | null; slackChannelId?: string | null }) =>
      json(
        await fetch(`/api/projects/${projectId}/notifications`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(data),
        }),
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["project-notifications", projectId] });
      toast({ title: "Saved" });
    },
    onError: fail("Could not save"),
  });

  const p = project.data;
  return (
    <aside
      className={cn(
        "relative flex h-full flex-col overflow-y-auto bg-background",
        embedded ? "w-full" : "w-[min(400px,40vw)] min-w-[320px] shrink-0 border-l border-border",
      )}
    >
      {!embedded && (
        <>
          <div data-tauri-drag-region className="titlebar-only absolute inset-x-0 top-0 h-10" />
          <Button size="icon-sm" variant="ghost" className="absolute top-3 right-3 rounded-full" onClick={onClose} aria-label="Close details">
            <X className="h-4 w-4" />
          </Button>
        </>
      )}

      {!p ? (
        <div className="flex flex-1 items-center justify-center text-[12.5px] text-muted-foreground">
          {project.isError ? (project.error as Error).message : <Loader2 className="h-4 w-4 animate-spin" />}
        </div>
      ) : (
        <>
          {/* Who this is: the chat's face, the project's name and what it is. */}
          <div className={cn("flex flex-col items-center gap-3 px-6 pb-4 text-center", embedded ? "pt-6" : "pt-10")}>
            <BotAvatar shape={bot.shape} color={bot.color} size={64} />
            <div className="space-y-1">
              <h2 className="text-[16px] font-medium">{p.name}</h2>
              {p.description && <p className="line-clamp-3 text-[12px] text-muted-foreground">{p.description}</p>}
            </div>
            {p.workspacePath && (
              <code
                className="max-w-full truncate rounded-full border border-border px-2.5 py-0.5 text-[11px] text-muted-foreground"
                title={p.workspacePath}
              >
                {p.workspacePath.replace(/^\/Users\/[^/]+/, "~")}
              </code>
            )}
          </div>

          <div className={cn("space-y-5 px-4 pb-6", embedded && "mx-auto w-full max-w-xl")}>
            {/* ---- Tasks ---- */}
            <ProjectTodos projectId={projectId} />

            {/* ---- Repositories & folders ---- */}
            <Section
              title={`Repositories · ${p.repositories.length}`}
              action={<AddButton open={adding !== null} label="Add" onClick={() => setAdding(adding ? null : "menu")} />}
            >
              {adding && (
                <div className={cn(card, "space-y-1 p-1.5")}>
                  {adding === "menu" ? (
                    <>
                      <button type="button" onClick={() => setPicking(true)} className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[13px] hover:bg-accent">
                        <FolderOpen className="h-4 w-4 text-muted-foreground" /> A folder on this Mac
                      </button>
                      <button type="button" onClick={() => setAdding("git")} className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[13px] hover:bg-accent">
                        <GitBranch className="h-4 w-4 text-muted-foreground" /> A Git repository
                      </button>
                    </>
                  ) : (
                    <form
                      className="flex gap-1.5 p-1"
                      onSubmit={(e) => {
                        e.preventDefault();
                        const [url] = parseGitUrls(gitInput);
                        if (url) addRepo.mutate({ name: repoNameFromUrl(url), repoUrl: url });
                      }}
                    >
                      <input
                        autoFocus
                        value={gitInput}
                        onChange={(e) => setGitInput(e.target.value)}
                        placeholder="https://github.com/org/repo.git"
                        className="h-8 min-w-0 flex-1 rounded-lg border border-input bg-transparent px-2.5 font-mono text-[11.5px] outline-none focus:border-ring"
                      />
                      <Button type="submit" size="sm" className="h-8 rounded-lg" disabled={!parseGitUrls(gitInput).length || addRepo.isPending}>
                        {addRepo.isPending && <Loader2 className="h-3 w-3 animate-spin" />} Add
                      </Button>
                    </form>
                  )}
                </div>
              )}
              <ul className={cn(card, "divide-y divide-border/60 overflow-hidden")}>
                {p.repositories.map((r) => (
                  <li key={r.id} className="group flex items-center gap-2.5 px-3 py-2">
                    <span
                      title={r.cloneStatus}
                      className={cn("h-2 w-2 shrink-0 rounded-full", CLONE_DOT[r.cloneStatus] ?? "bg-muted-foreground")}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-1.5 text-[13px]">
                        <span className="truncate">{r.name}</span>
                        {r.isMain && <span className="shrink-0 rounded-full bg-accent px-1.5 text-[10px] text-muted-foreground">main</span>}
                      </span>
                      <span className="block truncate text-[11px] text-muted-foreground" title={r.repoUrl ?? r.localPath ?? ""}>
                        {shortSource(r)}
                      </span>
                    </span>
                    {r.cloneStatus !== "ready" && <span className="shrink-0 text-[11px] text-muted-foreground">{r.cloneStatus}</span>}
                    <button
                      type="button"
                      onClick={() => setRemoving(r)}
                      aria-label={`Remove ${r.name}`}
                      className="shrink-0 rounded-md p-1 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 hover:text-destructive focus-visible:opacity-100"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </li>
                ))}
                {p.repositories.length === 0 && <li className="px-3 py-2.5 text-[12.5px] text-muted-foreground">No repositories yet.</li>}
              </ul>
            </Section>

            {/* ---- Skills ---- */}
            <Section
              title={`Skills · ${loaded.data?.length ?? 0}`}
              action={<AddButton open={skillPicker} label="Add" onClick={() => setSkillPicker(!skillPicker)} />}
            >
              {skillPicker && (
                <div className={cn(card, "max-h-52 overflow-y-auto p-1")}>
                  {available.length === 0 ? (
                    <p className="px-2.5 py-2 text-[12px] text-muted-foreground">Every skill in the library is loaded.</p>
                  ) : (
                    available.map((s) => (
                      <button
                        key={s.id}
                        type="button"
                        onClick={() => setSkills.mutate([...loadedIds, s.id])}
                        className="flex w-full items-start gap-2.5 rounded-lg px-2.5 py-1.5 text-left hover:bg-accent"
                      >
                        <Sparkles className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                        <span className="min-w-0">
                          <span className="block text-[12.5px]">{s.name}</span>
                          {s.description && <span className="line-clamp-1 block text-[11px] text-muted-foreground">{s.description}</span>}
                        </span>
                      </button>
                    ))
                  )}
                </div>
              )}
              {(loaded.data ?? []).length === 0 ? (
                <p className={cn(card, "px-3 py-2.5 text-[12.5px] text-muted-foreground")}>
                  None yet — skills you add go into this project&apos;s sandboxes.
                </p>
              ) : (
                <div className="flex flex-wrap gap-1.5 px-1">
                  {(loaded.data ?? []).map((s) => (
                    <span
                      key={s.id}
                      title={s.description ?? undefined}
                      className="flex items-center gap-1.5 rounded-full border border-border bg-card/60 py-1 pr-1.5 pl-2.5 text-[12px]"
                    >
                      <Sparkles className="h-3 w-3 text-muted-foreground" />
                      {s.name}
                      <button
                        type="button"
                        onClick={() => setSkills.mutate([...loadedIds].filter((id) => id !== s.id))}
                        aria-label={`Remove ${s.name}`}
                        className="rounded-full p-0.5 text-muted-foreground hover:bg-accent hover:text-destructive"
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </span>
                  ))}
                </div>
              )}
            </Section>

            {/* ---- Notifications ---- */}
            <Section title="Notifications">
              <div className={cn(card, "divide-y divide-border/60")}>
                <NotifyRow
                  brand="telegram"
                  label="Telegram"
                  connected={telegram.data?.configured ?? false}
                  connectedAs={telegram.data?.username ? `@${telegram.data.username}` : null}
                  placeholder="Chat or group id (-100…)"
                  value={notif.data?.telegramChatId ?? null}
                  saving={saveNotif.isPending}
                  onSave={(v) => saveNotif.mutate({ telegramChatId: v })}
                />
                <NotifyRow
                  brand="slack"
                  label="Slack"
                  connected={slack.data?.configured ?? false}
                  connectedAs={slack.data?.team ?? null}
                  placeholder="Channel (#colony)"
                  value={notif.data?.slackChannelId ?? null}
                  saving={saveNotif.isPending}
                  onSave={(v) => saveNotif.mutate({ slackChannelId: v })}
                />
              </div>
            </Section>
          </div>
        </>
      )}

      <FolderPicker
        open={picking}
        onOpenChange={setPicking}
        initialPath={p?.workspacePath ?? "~/Projects"}
        onSelect={(folder) => {
          setPicking(false);
          addRepo.mutate({ name: folder.split("/").filter(Boolean).pop() ?? "folder", localPath: folder });
        }}
      />
      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(open) => !open && setRemoving(null)}
        title={`Remove ${removing?.name ?? ""} from the project?`}
        description="Only from the project — its folder and files on your disk stay as they are. New sandboxes will not include it."
        confirmLabel="Remove"
        onConfirm={() => {
          if (removing) removeRepo.mutate(removing);
          setRemoving(null);
        }}
      />
    </aside>
  );
}

function NotifyRow({
  brand,
  label,
  connected,
  connectedAs,
  placeholder,
  value,
  saving,
  onSave,
}: {
  brand: "telegram" | "slack";
  label: string;
  connected: boolean;
  connectedAs: string | null;
  placeholder: string;
  value: string | null;
  saving: boolean;
  onSave: (value: string | null) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft ?? value ?? "";
  return (
    <div className="px-3 py-2.5">
      <div className="flex items-center gap-2.5 text-[13px]">
        <BrandIcon brand={brand} className="h-4 w-4" />
        {label}
        <span className={cn("ml-auto text-[11px]", connected ? "text-emerald-400/90" : "text-muted-foreground")}>
          {connected ? (connectedAs ?? "connected") : "not connected"}
        </span>
      </div>
      {!connected && <p className="pt-1 pl-[26px] text-[11.5px] text-muted-foreground">Connect it in Connect apps first.</p>}
      {connected && (
        <form
          className="flex gap-1.5 pt-2 pl-[26px]"
          onSubmit={(e) => {
            e.preventDefault();
            onSave(shown.trim() || null);
            setDraft(null);
          }}
        >
          <input
            value={shown}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={placeholder}
            className="h-8 min-w-0 flex-1 rounded-lg border border-input bg-transparent px-2.5 font-mono text-[11.5px] outline-none focus:border-ring"
          />
          <Button type="submit" size="sm" variant="secondary" className="h-8 rounded-lg" disabled={saving || draft === null}>
            Save
          </Button>
        </form>
      )}
    </div>
  );
}
