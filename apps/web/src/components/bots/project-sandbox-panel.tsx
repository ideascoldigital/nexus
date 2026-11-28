"use client";

// The right-hand panel of a project chat (spec 39) — what the computer is to
// an assistant — laid out as surfaces in tabs: terminals and files, on this
// Mac (the project's own folder, no sandbox needed) or inside its sandbox,
// and the sandbox's setup log and preview. "+" (or T, F, L, P with the panel
// focused) opens one; an empty panel lists them. While the sandbox boots it
// opens on its setup log, and adds a terminal once the machine is running.

import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import dynamic from "next/dynamic";
import {
  ArrowLeft,
  ChevronRight,
  ExternalLink,
  File as FileIcon,
  Folder,
  GitPullRequest,
  Globe,
  Laptop,
  Loader2,
  Lock,
  Maximize2,
  Minimize2,
  Plus,
  RefreshCw,
  ScrollText,
  Settings,
  ListTodo,
  SquareTerminal,
  X,
} from "lucide-react";

import { ProjectDetailsPanel } from "@/components/bots/project-details-panel";
import { ProjectTodos } from "@/components/bots/project-todos";
import { PullRequestsSurface } from "@/components/bots/pull-requests-surface";
import { Button } from "@/components/ui/button";
import type { BotShape } from "@/lib/bot-shapes";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { dockerTerminalTarget } from "@/lib/terminal-target";
import { cn } from "@/lib/utils";
import { getSandboxes, type SandboxSummary } from "@/services/sandbox";

// xterm touches `window` at import: client only.
const RealTerminal = dynamic(() => import("@/components/terminal/real-terminal").then((m) => m.RealTerminal), {
  ssr: false,
});

export type SurfaceKind = "terminal" | "files" | "log" | "preview" | "prs" | "tasks" | "settings";
/** Kept for the chat header's "Sandbox ▾" menu, which opens one of these. */
export type SandboxTab = "terminal" | "log";

const SURFACES: { kind: SurfaceKind; label: string; key: string; icon: typeof SquareTerminal }[] = [
  { kind: "terminal", label: "Terminal", key: "T", icon: SquareTerminal },
  { kind: "files", label: "Files", key: "F", icon: FileIcon },
  { kind: "log", label: "Setup log", key: "L", icon: ScrollText },
  { kind: "preview", label: "Preview", key: "P", icon: Globe },
  { kind: "prs", label: "Pull requests", key: "R", icon: GitPullRequest },
  { kind: "tasks", label: "Tasks", key: "K", icon: ListTodo },
  { kind: "settings", label: "Settings", key: "S", icon: Settings },
];

/** A terminal keeps the place it opened in: this Mac or the sandbox. */
type Tab = {
  id: string;
  kind: SurfaceKind;
  n: number;
  cwd?: string;
  local?: boolean;
  /** Typed into the terminal once it is up (a Run from the chat), and its tab's name. */
  command?: string;
  title?: string;
};

/** Commands the chat's Run card starts on this Mac, each in its repository's folder. */
export type RunRequest = { repo: string; command: string; label: string };

type ProjectFolders = {
  workspacePath: string | null;
  repositories: { name: string; localPath: string | null; isMain: boolean }[];
};

/** Where a terminal on this Mac opens: the main repository's folder, else the project's. */
function localFolder(p: ProjectFolders | undefined): string | null {
  if (!p) return null;
  const repo = p.repositories.find((r) => r.isMain && r.localPath) ?? p.repositories.find((r) => r.localPath);
  return repo?.localPath ?? p.workspacePath ?? null;
}

const STATUS_DOT: Record<string, string> = {
  running: "bg-emerald-400",
  provisioning: "bg-amber-400 animate-pulse",
  pending: "bg-amber-400 animate-pulse",
  error: "bg-destructive",
  destroying: "bg-muted-foreground",
  destroyed: "bg-muted-foreground",
};

/** Where a terminal into this sandbox opens, or null when it cannot yet. */
function terminalCwd(s: SandboxSummary): string | null {
  if (s.status !== "running") return null;
  if (s.provider === "local") return dockerTerminalTarget(s, "/opt/nexus");
  return s.publicIp ? `ssh://nexus@${s.publicIp}/opt/nexus` : null;
}

export function useProjectSandboxes(projectId: string | null) {
  return useQuery({
    queryKey: ["sandboxes", projectId],
    queryFn: () => getSandboxes(projectId!),
    enabled: Boolean(projectId),
    // While one boots, follow it; once settled, a slow refresh is enough.
    refetchInterval: (q) =>
      (q.state.data ?? []).some((s) => s.status === "provisioning" || s.status === "pending") ? 4000 : 20_000,
  });
}

let seq = 0;
const newTab = (kind: SurfaceKind, tabs: Tab[], extra: Partial<Tab> = {}): Tab => ({
  id: `${kind}-${Date.now().toString(36)}-${seq++}`,
  kind,
  n: Math.max(0, ...tabs.filter((t) => t.kind === kind).map((t) => t.n)) + 1,
  ...extra,
});
const tabLabel = (t: Tab) => {
  if (t.title) return t.title;
  const base = SURFACES.find((s) => s.kind === t.kind)!.label;
  return t.kind === "terminal" && t.n > 1 ? `${base} ${t.n}` : base;
};

export function ProjectSandboxPanel({
  projectId,
  bot,
  open: requested,
  expanded,
  onExpand,
  onClose,
}: {
  projectId: string;
  /** The chat's face, for the Settings surface. */
  bot: { shape: BotShape; color: string };
  /** A surface the chat header asked for (Sandbox ▾); bumps open one. `run`: terminals to start commands in. */
  open: { kind: SurfaceKind; at: number; run?: RunRequest[] } | null;
  expanded: boolean;
  onExpand: (expanded: boolean) => void;
  onClose: () => void;
}) {
  const sandboxes = useProjectSandboxes(projectId);
  const live = (sandboxes.data ?? []).filter((s) => s.status !== "destroyed" && !s.archived);
  // A pick holds until a newer sandbox appears, which then takes the panel over.
  const newest = live[0]?.id ?? null;
  const [picked, setPicked] = useState<{ id: string; newest: string | null } | null>(null);
  const current = live.find((s) => picked && picked.newest === newest && s.id === picked.id) ?? live[0] ?? null;
  const cwd = current ? terminalCwd(current) : null;
  const booting = current?.status === "provisioning" || current?.status === "pending";
  const project = useQuery({
    queryKey: ["project", projectId],
    queryFn: async () => {
      const res = await fetch(`/api/projects/${projectId}`);
      if (!res.ok) throw new Error("Could not load the project");
      return (await res.json()) as ProjectFolders;
    },
  });
  const here = localFolder(project.data);
  // Files: the sandbox's when one runs, unless switched to this Mac.
  const [filesLocal, setFilesLocal] = useState(false);

  const [tabs, setTabs] = useState<Tab[]>([]);
  const [active, setActive] = useState<string | null>(null);
  /** A terminal opens in the sandbox when it runs, otherwise (or when asked) on this Mac. */
  const terminalPlace = (onMac?: boolean): Partial<Tab> =>
    !onMac && cwd ? { cwd, local: false } : { cwd: here ?? "", local: true };
  const openSurface = (kind: SurfaceKind, onMac?: boolean) => {
    // One of each, except terminals: "+ Terminal" is another shell.
    const existing = kind === "terminal" ? null : tabs.find((t) => t.kind === kind);
    if (existing) return setActive(existing.id);
    const tab = newTab(kind, tabs, kind === "terminal" ? terminalPlace(onMac) : {});
    setTabs([...tabs, tab]);
    setActive(tab.id);
  };
  const closeTab = (id: string) => {
    const rest = tabs.filter((t) => t.id !== id);
    setTabs(rest);
    if (active === id) setActive(rest.at(-1)?.id ?? null);
  };

  // Follow the sandbox (state adjusted while rendering, not in an effect):
  // its first appearance opens the setup log while it boots, or a terminal if
  // it already runs; when a booting one comes up, a terminal joins the log.
  const [seen, setSeen] = useState<{ id: string | null; status: string | null }>({ id: null, status: null });
  if (current && (seen.id !== current.id || seen.status !== current.status)) {
    const first = seen.id !== current.id;
    setSeen({ id: current.id, status: current.status });
    if (first && tabs.length === 0 && booting) {
      // Being set up: watch it happen. Otherwise the panel opens on its menu.
      const tab = newTab("log", []);
      setTabs([tab]);
      setActive(tab.id);
    } else if (!first && current.status === "running" && tabs.find((t) => t.id === active)?.kind === "log" && !tabs.some((t) => t.kind === "terminal")) {
      const tab = newTab("terminal", tabs, { cwd: cwd ?? undefined, local: false });
      setTabs([...tabs, tab]);
      setActive(tab.id);
    }
  }
  // The chat header's Sandbox ▾ asked for a surface.
  const [handled, setHandled] = useState(0);
  if (requested && requested.at !== handled && (!requested.run || project.data)) {
    setHandled(requested.at);
    if (requested.run?.length) {
      // One terminal per command, on this Mac, in its repository's folder
      // (only the project's own repositories — never a path from the chat).
      let next = tabs;
      let focus: string | null = null;
      for (const r of requested.run) {
        // Already showing that output: go to it instead of opening another.
        const same = next.find((t) => t.kind === "terminal" && t.command === r.command);
        if (same) {
          focus ??= same.id;
          continue;
        }
        const repo = project.data?.repositories.find((x) => x.name === r.repo);
        const tab = newTab("terminal", next, { local: true, cwd: repo?.localPath ?? here ?? "", command: r.command, title: r.label });
        next = [...next, tab];
        focus ??= tab.id;
      }
      setTabs(next);
      if (focus) setActive(focus);
    } else openSurface(requested.kind);
  }

  // T, F, L, P open surfaces while the panel has focus (not while typing in it).
  const rootRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (e.metaKey || e.ctrlKey || e.altKey || t.closest("input, textarea, .xterm")) return;
      const s = SURFACES.find((x) => x.key === e.key.toUpperCase());
      if (s) {
        e.preventDefault();
        openSurface(s.kind);
      }
    };
    el.addEventListener("keydown", onKey);
    return () => el.removeEventListener("keydown", onKey);
  });

  const activeTab = tabs.find((t) => t.id === active) ?? null;

  // ⌘W in the desktop app closes the tab you are in, not the window (the
  // native menu's "Close Tab" calls this). Nothing open: nothing happens.
  useEffect(() => {
    const w = window as unknown as { __nexuxCloseTab?: () => void };
    w.__nexuxCloseTab = () => {
      if (active) closeTab(active);
    };
    return () => {
      delete w.__nexuxCloseTab;
    };
  });

  return (
    <aside
      ref={rootRef}
      tabIndex={-1}
      className={cn(
        "flex h-full shrink-0 flex-col overflow-hidden border-l border-border bg-background outline-none",
        // Its width is a share of the room it has (not of the window), so it
        // never pushes the chat — or itself — past the window's edge.
        expanded ? "min-w-0 flex-1" : "w-[42%] max-w-[600px] min-w-[320px]",
      )}
    >
      {/* Tabs, "+", and the panel's own controls. */}
      <header className="flex h-12 shrink-0 items-center gap-1 border-b border-border px-2">
        <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
          {tabs.map((t) => {
            const Icon = SURFACES.find((s) => s.kind === t.kind)!.icon;
            return (
              <div
                key={t.id}
                className={cn(
                  "group flex shrink-0 items-center gap-1.5 rounded-md py-1 pr-1 pl-2 text-[12.5px] transition-colors",
                  t.id === active ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground",
                )}
              >
                <button type="button" className="flex items-center gap-1.5" onClick={() => setActive(t.id)}>
                  {t.kind === "terminal" && t.local && cwd ? <Laptop className="h-3.5 w-3.5" /> : <Icon className="h-3.5 w-3.5" />}
                  {tabLabel(t)}
                </button>
                <button
                  type="button"
                  onClick={() => closeTab(t.id)}
                  aria-label={`Close ${tabLabel(t)}`}
                  className="rounded p-0.5 opacity-0 group-hover:opacity-100 hover:bg-background/60"
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            );
          })}
          <DropdownMenu>
            <DropdownMenuTrigger
              render={<Button size="icon-sm" variant="ghost" className="shrink-0 rounded-md" aria-label="Open a surface" />}
            >
              <Plus className="h-3.5 w-3.5" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-52">
              {SURFACES.map((s) => (
                <DropdownMenuItem key={s.kind} onClick={() => openSurface(s.kind)}>
                  <s.icon />
                  <span className="flex-1">{s.kind === "terminal" && cwd ? "Terminal in the sandbox" : s.label}</span>
                  <kbd className="rounded bg-muted px-1.5 text-[10px] text-muted-foreground">{s.key}</kbd>
                </DropdownMenuItem>
              ))}
              {cwd && (
                <DropdownMenuItem onClick={() => openSurface("terminal", true)}>
                  <Laptop />
                  <span className="flex-1">Terminal on this Mac</span>
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        <Button
          size="icon-sm"
          variant="ghost"
          className="rounded-md"
          onClick={() => onExpand(!expanded)}
          aria-label={expanded ? "Back beside the chat" : "Expand"}
          title={expanded ? "Back beside the chat" : "Expand"}
        >
          {expanded ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
        </Button>
        <Button size="icon-sm" variant="ghost" className="rounded-md" onClick={onClose} aria-label="Close the panel">
          <X className="h-3.5 w-3.5" />
        </Button>
      </header>

      <div className="relative min-h-0 flex-1">
        {activeTab?.kind === "settings" ? (
          <ProjectDetailsPanel projectId={projectId} bot={bot} embedded />
        ) : activeTab?.kind === "prs" ? (
          <PullRequestsSurface projectId={projectId} />
        ) : activeTab?.kind === "tasks" ? (
          <div className="h-full overflow-y-auto px-4 py-4">
            <div className="mx-auto w-full max-w-xl">
              <ProjectTodos projectId={projectId} />
            </div>
          </div>
        ) : !activeTab ? (
          <div className="flex h-full flex-col items-center justify-center gap-3">
            <p className="text-[13px] font-medium">Open a surface</p>
            {!current && !sandboxes.isLoading && (
              <p className="-mt-1 max-w-64 text-center text-[11.5px] text-muted-foreground">
                Terminal and Files work on this Mac. Setup log and Preview need a sandbox — ask the chat to run it.
              </p>
            )}
            <div className="w-64 space-y-0.5">
              {SURFACES.map((s) => (
                <button
                  key={s.kind}
                  type="button"
                  onClick={() => openSurface(s.kind)}
                  className="flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-[13px] text-muted-foreground hover:bg-accent hover:text-foreground"
                >
                  <s.icon className="h-4 w-4" />
                  <span className="flex-1">{s.label}</span>
                  <kbd className="rounded bg-muted px-1.5 text-[10px]">{s.key}</kbd>
                </button>
              ))}
            </div>
          </div>
        ) : !current && (activeTab.kind === "log" || activeTab.kind === "preview") ? (
          <Centered>
            {sandboxes.isLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : "This needs a sandbox — ask the chat to run the project."}
          </Centered>
        ) : null}

        {/* Terminals stay mounted while hidden, so their shells live on. */}
        {tabs
          .filter((t) => t.kind === "terminal")
          .map((t) => {
            // A terminal opened before the project loaded starts in its folder once known.
            const where = t.local ? t.cwd || here || "" : t.cwd;
            return (
              <div key={t.id} className={cn("absolute inset-0", t.id === active ? "block" : "hidden")}>
                {where || t.local ? (
                  <RealTerminal key={`${t.id}:${where}`} workingDirectory={where || undefined} initialCommand={t.command} />
                ) : (
                  <Centered>The terminal opens when the sandbox is running.</Centered>
                )}
              </div>
            );
          })}
        {activeTab?.kind === "files" && (
          <div className="flex h-full flex-col">
            {current?.status === "running" && (
              <div className="flex shrink-0 gap-1 border-b border-border px-2 py-1.5">
                {[
                  { local: true, label: "This Mac" },
                  { local: false, label: "Sandbox" },
                ].map((o) => (
                  <button
                    key={o.label}
                    type="button"
                    onClick={() => setFilesLocal(o.local)}
                    className={cn(
                      "rounded-md px-2 py-0.5 text-[11.5px]",
                      filesLocal === o.local ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {o.label}
                  </button>
                ))}
              </div>
            )}
            <div className="min-h-0 flex-1">
              {current?.status === "running" && !filesLocal ? (
                <FilesSurface projectId={projectId} sandbox={current} />
              ) : (
                <LocalFilesSurface projectId={projectId} />
              )}
            </div>
          </div>
        )}
        {current && activeTab?.kind === "log" && <SetupLogSurface projectId={projectId} sandbox={current} />}
        {current && activeTab?.kind === "preview" && (
          current.previewUrl ? (
            <div className="flex h-full flex-col">
              <div className="flex items-center gap-2 border-b border-border px-3 py-1.5 text-[12px] text-muted-foreground">
                <span className="truncate font-mono">{current.previewUrl}</span>
                <a href={current.previewUrl} target="_blank" rel="noreferrer" className="ml-auto flex items-center gap-1 hover:text-foreground">
                  <ExternalLink className="h-3.5 w-3.5" /> Open
                </a>
              </div>
              <iframe src={current.previewUrl} className="min-h-0 flex-1 bg-white" title="Preview" />
            </div>
          ) : (
            <Centered>No preview yet — once an app runs in the sandbox with a live preview, it shows here.</Centered>
          )
        )}
      </div>

      {/* Where it runs, at a glance. */}
      {!current && here && (
        <footer className="flex h-7 shrink-0 items-center gap-1.5 border-t border-border px-3 text-[11px] text-muted-foreground">
          <Laptop className="h-3 w-3 shrink-0" />
          <span className="truncate font-mono" title={here}>
            This Mac · {here.replace(/^\/Users\/[^/]+/, "~")}
          </span>
        </footer>
      )}
      {current && (
        <footer className="flex h-7 shrink-0 items-center gap-1.5 border-t border-border px-3 text-[11px] text-muted-foreground">
          <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", STATUS_DOT[current.status] ?? "bg-muted-foreground")} />
          {live.length > 1 ? (
            <select
              value={current.id}
              onChange={(e) => setPicked({ id: e.target.value, newest })}
              className="min-w-0 truncate bg-transparent font-mono outline-none"
            >
              {live.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name} · {s.status}
                </option>
              ))}
            </select>
          ) : (
            <span className="truncate font-mono">
              {current.name} · {current.status}
            </span>
          )}
        </footer>
      )}
    </aside>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full items-center justify-center px-8 text-center text-[12.5px] text-muted-foreground">
      {children}
    </div>
  );
}

/** Nexus's provisioning steps, then the bootstrap log from inside the machine; follows its end. */
function SetupLogSurface({ projectId, sandbox }: { projectId: string; sandbox: SandboxSummary }) {
  const booting = sandbox.status === "provisioning" || sandbox.status === "pending";
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
    // Only once the machine exists; before that there is nothing inside to read.
    enabled: /bootstrap started|bootstrap complete/.test(provisioning.data ?? ""),
    refetchInterval: (q) => (q.state.data?.complete || q.state.data?.failed ? false : 4000),
    retry: false,
  });
  const failed = sandbox.status === "error" ? (sandbox.error ?? "Failed") : null;
  const text = [
    failed ? `Failed: ${failed}` : "",
    (provisioning.data ?? "").trim(),
    (bootstrap.data?.log ?? (bootstrap.isError ? `(${(bootstrap.error as Error).message})` : "")).trim(),
  ]
    .filter(Boolean)
    .join("\n\n");
  return (
    <pre
      ref={(el) => {
        // Stick to the bottom like a terminal, unless the user scrolled up.
        if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 80) el.scrollTop = el.scrollHeight;
      }}
      className="h-full overflow-auto px-3 py-2 font-mono text-[11.5px] leading-relaxed whitespace-pre-wrap text-muted-foreground"
    >
      {text || (booting ? "Starting… the setup log appears here as the machine comes up." : "No setup log.")}
      {booting && <span className="mt-1 block animate-pulse">▍</span>}
    </pre>
  );
}

type Listing = { path: string; entries: { name: string; dir: boolean; size: number }[] };

/** Browse /opt/nexus in the sandbox; open a file to read it. Read-only. */
function FilesSurface({ projectId, sandbox }: { projectId: string; sandbox: SandboxSummary }) {
  const [dir, setDir] = useState("/opt/nexus");
  const [file, setFile] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const running = sandbox.status === "running";
  const base = `/api/projects/${projectId}/sandboxes/${sandbox.id}/files`;

  const listing = useQuery({
    queryKey: ["sandbox-files", sandbox.id, dir],
    queryFn: async () => {
      const res = await fetch(`${base}?path=${encodeURIComponent(dir)}`);
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Could not list the folder");
      return body as Listing;
    },
    enabled: running && !file,
  });
  const content = useQuery({
    queryKey: ["sandbox-file", sandbox.id, file],
    queryFn: async () => {
      const res = await fetch(`${base}?file=${encodeURIComponent(file!)}`);
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Could not read the file");
      return body as { content: string | null; binary: boolean; truncated: boolean };
    },
    enabled: running && Boolean(file),
  });

  if (!running) return <Centered>Files show once the sandbox is running.</Centered>;

  const crumbs = dir.split("/").filter(Boolean);
  const entries = (listing.data?.entries ?? []).filter((e) => e.name.toLowerCase().includes(filter.trim().toLowerCase()));

  if (file) {
    return (
      <div className="flex h-full flex-col">
        <div className="flex items-center gap-2 border-b border-border px-2 py-1.5 text-[12px]">
          <Button size="icon-sm" variant="ghost" className="rounded-md" onClick={() => setFile(null)} aria-label="Back to the folder">
            <ArrowLeft className="h-3.5 w-3.5" />
          </Button>
          <span className="truncate font-mono text-muted-foreground" title={file}>
            {file.replace(/^\/opt\/nexus\//, "")}
          </span>
        </div>
        <pre className="min-h-0 flex-1 overflow-auto px-3 py-2 font-mono text-[11.5px] leading-relaxed whitespace-pre">
          {content.isLoading
            ? "Loading…"
            : content.isError
              ? (content.error as Error).message
              : content.data?.binary
                ? "(binary file)"
                : `${content.data?.content ?? ""}${content.data?.truncated ? "\n… (truncated)" : ""}`}
        </pre>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-1.5 border-b border-border px-2 py-1.5">
        <Button size="icon-sm" variant="ghost" className="rounded-md" onClick={() => listing.refetch()} aria-label="Refresh">
          <RefreshCw className={cn("h-3.5 w-3.5", listing.isFetching && "animate-spin")} />
        </Button>
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Search files"
          className="h-7 min-w-0 flex-1 rounded-md border border-input bg-transparent px-2 text-[12px] outline-none focus:border-ring"
        />
      </div>
      <div className="flex shrink-0 items-center gap-0.5 overflow-x-auto px-2 py-1 font-mono text-[11px] text-muted-foreground">
        {crumbs.map((c, i) => (
          <span key={i} className="flex shrink-0 items-center gap-0.5">
            {i > 0 && <ChevronRight className="h-3 w-3" />}
            <button
              type="button"
              className="hover:text-foreground"
              onClick={() => {
                setDir("/" + crumbs.slice(0, i + 1).join("/"));
                setFilter("");
              }}
            >
              {c}
            </button>
          </span>
        ))}
      </div>
      <ul className="min-h-0 flex-1 overflow-y-auto px-1 pb-2">
        {listing.isLoading && <li className="px-3 py-2 text-[12px] text-muted-foreground">Loading…</li>}
        {listing.isError && <li className="px-3 py-2 text-[12px] text-destructive">{(listing.error as Error).message}</li>}
        {entries.map((e) => (
          <li key={e.name}>
            <button
              type="button"
              onClick={() => {
                const next = `${dir.replace(/\/$/, "")}/${e.name}`;
                if (e.dir) {
                  setDir(next);
                  setFilter("");
                } else setFile(next);
              }}
              className={cn(
                "flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-[12.5px] hover:bg-accent",
                e.name.startsWith(".") || e.name === "node_modules" ? "text-muted-foreground" : "",
              )}
            >
              {e.dir ? <Folder className="h-3.5 w-3.5 shrink-0 text-muted-foreground" /> : <FileIcon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />}
              <span className="truncate">{e.name}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

type LocalListing = { path: string; entries: { name: string; dir: boolean; size: number; secret?: true }[] };

/**
 * The project's repositories as checked out on this Mac: browse, open a file
 * to read it. Read-only; files that may hold secrets (.env, keys) show locked.
 */
function LocalFilesSurface({ projectId }: { projectId: string }) {
  const base = `/api/projects/${projectId}/files`;
  const repos = useQuery({
    queryKey: ["local-repos", projectId],
    queryFn: async () => {
      const res = await fetch(base);
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Could not read the project");
      return (body.repos as { name: string; path: string }[]) ?? [];
    },
  });
  const [picked, setPicked] = useState<string | null>(null);
  const repo = picked ?? (repos.data?.length === 1 ? repos.data[0]!.name : null);
  const [dir, setDir] = useState(".");
  const [file, setFile] = useState<string | null>(null);
  const [filter, setFilter] = useState("");

  const listing = useQuery({
    queryKey: ["local-files", projectId, repo, dir],
    queryFn: async () => {
      const res = await fetch(`${base}?repo=${encodeURIComponent(repo!)}&path=${encodeURIComponent(dir)}`);
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Could not list the folder");
      return body as LocalListing;
    },
    enabled: Boolean(repo) && !file,
  });
  const content = useQuery({
    queryKey: ["local-file", projectId, repo, file],
    queryFn: async () => {
      const res = await fetch(`${base}?repo=${encodeURIComponent(repo!)}&file=${encodeURIComponent(file!)}`);
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Could not read the file");
      return body as { content?: string; binary?: boolean; truncated?: boolean };
    },
    enabled: Boolean(repo && file),
  });

  if (repos.isLoading) return <Centered><Loader2 className="h-4 w-4 animate-spin" /></Centered>;
  if (repos.isError) return <Centered>{(repos.error as Error).message}</Centered>;
  if (!repos.data?.length) return <Centered>None of this project&apos;s repositories is on this Mac yet.</Centered>;

  if (!repo) {
    return (
      <ul className="space-y-0.5 p-2">
        {repos.data.map((r) => (
          <li key={r.name}>
            <button
              type="button"
              onClick={() => setPicked(r.name)}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12.5px] hover:bg-accent"
            >
              <Folder className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <span className="truncate">{r.name}</span>
              <span className="ml-auto truncate font-mono text-[10.5px] text-muted-foreground">{r.path.replace(/^\/Users\/[^/]+/, "~")}</span>
            </button>
          </li>
        ))}
      </ul>
    );
  }

  if (file) {
    return (
      <div className="flex h-full flex-col">
        <div className="flex items-center gap-2 border-b border-border px-2 py-1.5 text-[12px]">
          <Button size="icon-sm" variant="ghost" className="rounded-md" onClick={() => setFile(null)} aria-label="Back to the folder">
            <ArrowLeft className="h-3.5 w-3.5" />
          </Button>
          <span className="truncate font-mono text-muted-foreground" title={file}>
            {file}
          </span>
        </div>
        <pre className="min-h-0 flex-1 overflow-auto px-3 py-2 font-mono text-[11.5px] leading-relaxed whitespace-pre">
          {content.isLoading
            ? "Loading…"
            : content.isError
              ? (content.error as Error).message
              : content.data?.binary
                ? "(binary file)"
                : `${content.data?.content ?? ""}${content.data?.truncated ? "\n… (truncated)" : ""}`}
        </pre>
      </div>
    );
  }

  const crumbs = dir === "." ? [] : dir.split("/").filter(Boolean);
  const entries = (listing.data?.entries ?? []).filter((e) => e.name.toLowerCase().includes(filter.trim().toLowerCase()));
  const go = (next: string) => {
    setDir(next || ".");
    setFilter("");
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-1.5 border-b border-border px-2 py-1.5">
        <Button size="icon-sm" variant="ghost" className="rounded-md" onClick={() => listing.refetch()} aria-label="Refresh">
          <RefreshCw className={cn("h-3.5 w-3.5", listing.isFetching && "animate-spin")} />
        </Button>
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Search files"
          className="h-7 min-w-0 flex-1 rounded-md border border-input bg-transparent px-2 text-[12px] outline-none focus:border-ring"
        />
      </div>
      <div className="flex shrink-0 items-center gap-0.5 overflow-x-auto px-2 py-1 font-mono text-[11px] text-muted-foreground">
        <button
          type="button"
          className="shrink-0 hover:text-foreground"
          onClick={() => {
            if (dir === "." && (repos.data?.length ?? 0) > 1) setPicked(null);
            go(".");
          }}
        >
          {repo}
        </button>
        {crumbs.map((c, i) => (
          <span key={i} className="flex shrink-0 items-center gap-0.5">
            <ChevronRight className="h-3 w-3" />
            <button type="button" className="hover:text-foreground" onClick={() => go(crumbs.slice(0, i + 1).join("/"))}>
              {c}
            </button>
          </span>
        ))}
      </div>
      <ul className="min-h-0 flex-1 overflow-y-auto px-1 pb-2">
        {listing.isLoading && <li className="px-3 py-2 text-[12px] text-muted-foreground">Loading…</li>}
        {listing.isError && <li className="px-3 py-2 text-[12px] text-destructive">{(listing.error as Error).message}</li>}
        {entries.map((e) => {
          const next = dir === "." ? e.name : `${dir}/${e.name}`;
          return (
            <li key={e.name}>
              <button
                type="button"
                disabled={e.secret}
                title={e.secret ? "May hold secrets — not shown here" : undefined}
                onClick={() => (e.dir ? go(next) : setFile(next))}
                className={cn(
                  "flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-[12.5px] enabled:hover:bg-accent",
                  e.secret || e.name.startsWith(".") || e.name === "node_modules" ? "text-muted-foreground" : "",
                )}
              >
                {e.secret ? (
                  <Lock className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                ) : e.dir ? (
                  <Folder className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                ) : (
                  <FileIcon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                )}
                <span className="truncate">{e.name}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
