"use client";

// The floating details card of a project chat (spec 39), after T3 Code's:
// opened from the chat's name, it says where the project runs, opens its
// folder, lists its repositories and open pull requests, and jumps to the
// panel's surfaces. Click outside or Escape closes it.

import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, FolderGit2, FolderOpen, Monitor, Settings, SquareTerminal } from "lucide-react";
import { siCursor, siZedindustries } from "simple-icons";

import { useProjectSandboxes, type SurfaceKind } from "@/components/bots/project-sandbox-panel";
import { PullRequestRow, useProjectPullRequests } from "@/components/bots/pull-requests-surface";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";

type ProjectView = {
  name: string;
  workspacePath: string | null;
  repositories: { id: string; name: string; isMain: boolean; cloneStatus: string }[];
};

type OpenerId = "finder" | "cursor" | "vscode" | "zed";
const OPENER_KEY = "nexux:project-opener";
const OPENER_LABEL: Record<OpenerId, string> = { finder: "Finder", cursor: "Cursor", vscode: "VS Code", zed: "Zed" };

/** The installed app's real icon (served from its bundle); its mark when that can't be read. */
function OpenerIcon({ id }: { id: OpenerId }) {
  const [failed, setFailed] = useState(false);
  if (!failed) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={`/api/open-with/${id}/icon`}
        alt=""
        aria-hidden
        className="h-[18px] w-[18px] shrink-0"
        onError={() => setFailed(true)}
      />
    );
  }
  return <OpenerMark id={id} />;
}

function OpenerMark({ id }: { id: OpenerId }) {
  if (id === "finder") return <FolderOpen className="h-4 w-4 shrink-0 text-sky-400" />;
  const icon = id === "cursor" ? siCursor : id === "zed" ? siZedindustries : null;
  if (!icon) {
    return (
      <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-[4px] bg-[#007ACC] text-[8px] font-bold text-white">
        VS
      </span>
    );
  }
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4 shrink-0" fill="currentColor" aria-hidden>
      <path d={icon.path} />
    </svg>
  );
}

const row = "flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-[13px] transition-colors hover:bg-accent/60";

export function ProjectCard({
  projectId,
  onOpenSurface,
  onClose,
  pinned = false,
}: {
  projectId: string;
  onOpenSurface: (kind: SurfaceKind) => void;
  onClose: () => void;
  /** Always there, at the chat's top right (wide chats); otherwise a popover under its name. */
  pinned?: boolean;
}) {
  const { toast } = useToast();
  const ref = useRef<HTMLDivElement | null>(null);
  const [reposOpen, setReposOpen] = useState(false);
  const project = useQuery({
    queryKey: ["project", projectId],
    queryFn: async () => {
      const res = await fetch(`/api/projects/${projectId}`);
      if (!res.ok) throw new Error("Could not load the project");
      return (await res.json()) as ProjectView;
    },
  });
  const sandboxes = useProjectSandboxes(projectId);
  const prs = useProjectPullRequests(projectId);
  const sandbox = (sandboxes.data ?? []).find((s) => s.status !== "destroyed" && !s.archived) ?? null;
  const open = (prs.data?.items ?? []).filter((p) => p.state === "open" || p.state === "draft");

  useEffect(() => {
    if (pinned) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      // The chat's name toggles the card itself; let its click do that.
      if (t.closest("[data-card-toggle]")) return;
      if (ref.current && !ref.current.contains(t)) onClose();
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose, pinned]);

  // Open the folder with Finder or an installed editor; the last pick is
  // what the main button does next time.
  const openers = useQuery({
    queryKey: ["project-openers"],
    queryFn: async () => {
      const res = await fetch(`/api/projects/${projectId}/reveal`);
      return res.ok ? ((await res.json()).openers as OpenerId[]) : (["finder"] as OpenerId[]);
    },
    staleTime: 5 * 60_000,
  });
  const [preferred, setPreferred] = useState<OpenerId>(() => {
    try {
      const v = localStorage.getItem(OPENER_KEY) as OpenerId | null;
      return v && v in OPENER_LABEL ? v : "finder";
    } catch {
      return "finder";
    }
  });
  const usable = openers.data ?? ["finder"];
  const current: OpenerId = usable.includes(preferred) ? preferred : "finder";
  const [openMenu, setOpenMenu] = useState(false);
  const reveal = async (app: OpenerId) => {
    setOpenMenu(false);
    setPreferred(app);
    try {
      localStorage.setItem(OPENER_KEY, app);
    } catch {
      // not remembered
    }
    const res = await fetch(`/api/projects/${projectId}/reveal`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ app }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      toast({ title: "Could not open the folder", description: body.error, variant: "destructive" });
    }
  };
  const go = (kind: SurfaceKind) => {
    onOpenSurface(kind);
    if (!pinned) onClose();
  };

  const repos = project.data?.repositories ?? [];
  const shownRepos = reposOpen ? repos : repos.slice(0, 1);

  return (
    <div
      ref={ref}
      className={cn(
        "absolute top-14 z-30 rounded-2xl border border-border bg-popover p-1.5",
        pinned
          ? // Pinned at the chat's top right, beside the messages (the chat leaves it room).
            "right-4 w-[320px] shadow-lg"
          : // A popover under the chat's name, centred on the column; narrows with it.
            "left-1/2 w-[360px] max-w-[calc(100%-2rem)] -translate-x-1/2 shadow-2xl",
      )}
    >
      {/* Where it runs. */}
      <div className="flex items-center gap-2.5 px-2.5 py-1.5 text-[13px]">
        <Monitor className="h-4 w-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate">
          {sandbox ? (
            <>
              <span className="font-mono text-[12px]">{sandbox.name}</span>
              <span className="text-muted-foreground"> · {sandbox.status}</span>
            </>
          ) : (
            <span className="text-muted-foreground">On this Mac · no sandbox</span>
          )}
        </span>
        <span
          className={cn(
            "h-2 w-2 shrink-0 rounded-full",
            sandbox?.status === "running" ? "bg-emerald-400" : sandbox ? "bg-amber-400 animate-pulse" : "bg-muted-foreground/40",
          )}
        />
      </div>
      {project.data?.workspacePath && (
        <div className="relative">
          {/* Split button: open with the last app; the chevron picks another. */}
          <div className="flex items-stretch rounded-lg bg-accent/40">
            <button type="button" onClick={() => reveal(current)} className={cn(row, "rounded-r-none")}>
              <OpenerIcon id={current} />
              <span className="flex-1">Open in {OPENER_LABEL[current]}</span>
            </button>
            {usable.length > 1 && (
              <button
                type="button"
                onClick={() => setOpenMenu(!openMenu)}
                aria-label="Open with…"
                aria-expanded={openMenu}
                className="flex w-8 shrink-0 items-center justify-center rounded-r-lg border-l border-border/60 text-muted-foreground hover:bg-accent hover:text-foreground"
              >
                <ChevronDown className={cn("h-3.5 w-3.5 transition-transform", openMenu && "rotate-180")} />
              </button>
            )}
          </div>
          {openMenu && (
            <div className="absolute top-full right-0 left-0 z-10 mt-1 rounded-xl border border-border bg-popover p-1 shadow-xl">
              {usable.map((id) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => reveal(id)}
                  className={cn(row, id === current && "bg-accent/60")}
                >
                  <OpenerIcon id={id} />
                  <span className="flex-1">{OPENER_LABEL[id]}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
      {sandbox?.status === "running" && (
        <button type="button" onClick={() => go("terminal")} className={row}>
          <SquareTerminal className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span className="flex-1">Open a terminal</span>
        </button>
      )}

      <div className="mx-2.5 my-1 h-px bg-border" />

      {/* Repositories. */}
      {shownRepos.map((r) => (
        <div key={r.id} className="flex items-center gap-2.5 px-2.5 py-1.5 text-[13px]">
          <FolderGit2 className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate">{r.name}</span>
          {r.isMain && <span className="shrink-0 rounded-full bg-accent px-1.5 text-[10px] text-muted-foreground">main</span>}
        </div>
      ))}
      {repos.length > 1 && (
        <button type="button" onClick={() => setReposOpen(!reposOpen)} className={cn(row, "text-muted-foreground")}>
          <ChevronDown className={cn("h-4 w-4 shrink-0 transition-transform", reposOpen && "rotate-180")} />
          {reposOpen ? "Show less" : `Show ${repos.length - 1} more`}
        </button>
      )}

      {/* Open pull requests. */}
      {open.length > 0 && (
        <>
          <div className="mx-2.5 my-1 h-px bg-border" />
          {open.slice(0, 3).map((pr) => (
            <PullRequestRow key={pr.url} pr={pr} compact />
          ))}
          <button type="button" onClick={() => go("prs")} className={cn(row, "text-muted-foreground")}>
            <ChevronDown className="h-4 w-4 shrink-0 -rotate-90" />
            {open.length > 3 ? `All ${open.length} open pull requests` : "All pull requests"}
          </button>
        </>
      )}

      <div className="mx-2.5 my-1 h-px bg-border" />
      <button type="button" onClick={() => go("settings")} className={row}>
        <Settings className="h-4 w-4 shrink-0 text-muted-foreground" />
        <span className="flex-1">Settings</span>
      </button>
    </div>
  );
}
