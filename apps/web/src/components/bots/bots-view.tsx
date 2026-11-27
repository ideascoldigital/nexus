"use client";

// Bots (spec 31): AI teammates, each with its own ephemeral computer.
// An inbox of bots on the left (latest message, unread dot), the conversation
// in the middle, the bot's panel on the right (activity, computer, settings).
// The computer opens as a big live screen you can take control of, or anchored
// to the right of the chat so you can watch while you type (D-94).
//
// Both sides fold away: the inbox collapses to a rail of faces, and the right
// side holds either the panel or the computer, never both.
//
// The inbox is one workspace's team (D-87); the title bar's switcher is how
// you move between them.

import { useCallback, useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Settings,
  Loader2,
  MessageSquare,
  PanelLeftClose,
  PanelLeftOpen,
  Pencil,
  Play,
  PowerOff,
  Plus,
  Search,
  Trash2,
  X,
} from "lucide-react";

import { BotAvatar } from "@/components/bots/bot-avatar";
import { BotChat } from "@/components/bots/bot-chat";
import { ComputerDialog, ComputerDock, useComputerControl } from "@/components/bots/bot-computer";
import { BotPanel } from "@/components/bots/bot-panel";
import { ProjectSandboxPanel, useProjectSandboxes, type SurfaceKind } from "@/components/bots/project-sandbox-panel";
import { ProjectCard } from "@/components/bots/project-card";
import { NewBotDialog } from "@/components/bots/new-bot-dialog";
import { WorkspaceSwitcher } from "@/components/layout/workspace-switcher";
import { panelOf, SettingsPanel, type SettingsPanelKind } from "@/components/settings/settings-panel";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { ResizeHandle } from "@/components/ui/resize-handle";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import {
  BOTS_KEYS,
  DOCK_DEFAULT_WIDTH,
  INBOX_DEFAULT_WIDTH,
  PANEL_DEFAULT_WIDTH,
  clampDockWidth,
  clampInboxWidth,
  clampPanelWidth,
  dockModeFor,
  rememberDockMode,
  type DockMode,
} from "@/lib/bot-layout";
import { HANDBACK_PROMPT } from "@/lib/bot-prompts";
import { cn } from "@/lib/utils";
import {
  deleteBot,
  getBotFeed,
  getBots,
  sendBotPrompt,
  restartBotComputer,
  startBotComputer,
  stopBotComputer,
  updateBot,
  type BotFeed,
  type BotListItem,
} from "@/services/bots";

// ---- Per-viewer memory (browser storage: a convenience, never required) -------

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = typeof window === "undefined" ? null : window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(key: string, value: unknown) {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // private mode / blocked storage: unread dots just reset
  }
}

/** When each bot's latest message was last seen, to show unread dots and the NEW line. */
function useSeen() {
  const [seen, setSeen] = useState<Record<string, string>>(() => readJson(BOTS_KEYS.seen, {}));
  const markSeen = (botId: string, at: string | null) => {
    if (!at || seen[botId] === at) return;
    const next = { ...seen, [botId]: at };
    setSeen(next);
    writeJson(BOTS_KEYS.seen, next);
  };
  return { seen, markSeen };
}

function isUnread(bot: BotListItem, seenAt: string | undefined): boolean {
  if (!bot.previewAt || bot.activity === "working") return false;
  return !seenAt || new Date(bot.previewAt) > new Date(seenAt);
}

// ---- Page ---------------------------------------------------------------------

export function BotsView() {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  // Vault, Connect apps and Settings are modals here, not pages. Old links
  // (/settings?tab=…) are redirected to /bots?settings=1&tab=…, which opens
  // whichever of the three holds that section.
  const [panel, setPanel] = useState<{ kind: SettingsPanelKind; tab: string | null } | null>(() => {
    if (typeof window === "undefined") return null;
    const params = new URLSearchParams(window.location.search);
    if (!params.has("settings")) return null;
    const tab = params.get("tab");
    return { kind: panelOf(tab), tab };
  });
  const closePanel = (open: boolean) => {
    if (open) return;
    setPanel(null);
    const url = new URL(window.location.href);
    if (url.searchParams.has("settings")) {
      url.searchParams.delete("settings");
      url.searchParams.delete("tab");
      window.history.replaceState(window.history.state, "", url.toString());
    }
  };
  const [query, setQuery] = useState<string | null>(null);
  // The inbox folds to a rail of faces, so the chat and the bot's computer get
  // the whole window when you are watching one bot work.
  const [inboxOpen, setInboxOpen] = useState(() => readJson(BOTS_KEYS.inbox, true));
  const [inboxWidth, setInboxWidth] = useState(() =>
    clampInboxWidth(readJson(BOTS_KEYS.inboxWidth, INBOX_DEFAULT_WIDTH)),
  );
  const showInbox = (next: boolean) => {
    setInboxOpen(next);
    writeJson(BOTS_KEYS.inbox, next);
    if (!next) setQuery(null);
  };
  // Written back once the drag settles, not on every pointer move.
  useEffect(() => {
    const t = setTimeout(() => writeJson(BOTS_KEYS.inboxWidth, inboxWidth), 300);
    return () => clearTimeout(t);
  }, [inboxWidth]);
  // Right-click targets: the dialogs live here, one of each, rather than one per row.
  const [renaming, setRenaming] = useState<BotListItem | null>(null);
  const [deleting, setDeleting] = useState<BotListItem | null>(null);
  const { seen, markSeen } = useSeen();

  const { data: bots, isLoading } = useQuery({
    queryKey: ["bots"],
    queryFn: getBots,
    refetchInterval: 4000,
  });

  const qc = useQueryClient();
  const { toast } = useToast();
  const remove = useMutation({
    mutationFn: (id: string) => deleteBot(id),
    onSuccess: (_result, id) => {
      if (selectedId === id) setSelectedId(null);
      qc.invalidateQueries({ queryKey: ["bots"] });
    },
    onError: (err) =>
      toast({
        title: "Could not delete the bot",
        description: err instanceof Error ? err.message : undefined,
        variant: "destructive",
      }),
  });

  const selected = bots?.find((b) => b.id === selectedId) ?? bots?.[0] ?? null;
  const q = query?.trim().toLowerCase() ?? "";
  const visible = q
    ? bots?.filter((b) => `${b.name} ${b.role ?? ""} ${b.preview ?? ""}`.toLowerCase().includes(q))
    : bots;

  return (
    <div className="flex min-h-0 flex-1">
      {/* Inbox */}
      <aside
        style={inboxOpen ? { width: inboxWidth } : undefined}
        className={cn(
          "relative flex shrink-0 flex-col border-r border-border bg-sidebar",
          !inboxOpen && "w-[60px]",
        )}
      >
        {inboxOpen && (
          <ResizeHandle
            side="right"
            label="Resize the inbox"
            onResize={(x) => setInboxWidth(clampInboxWidth(x))}
            onReset={() => setInboxWidth(INBOX_DEFAULT_WIDTH)}
          />
        )}
        {/* Doubles as the window's title bar in the macOS app: traffic lights
            on the left, drag anywhere that is not a button. Collapsed, the rail
            is narrower than the traffic lights, so it starts below them. */}
        {/* Wraps rather than squashes: at a narrow width — or behind the 88px
            the traffic lights need in the macOS app — the buttons drop to a
            second line instead of overlapping each other. */}
        <div
          data-tauri-drag-region
          className={cn(
            "flex shrink-0 flex-wrap items-center gap-2",
            inboxOpen
              ? "titlebar-inset-left min-h-14 px-3 py-2"
              : "titlebar-inset-top justify-center px-2 py-3",
          )}
        >
          {!inboxOpen ? (
            <Button
              size="icon-sm"
              variant="secondary"
              className="rounded-full"
              onClick={() => showInbox(true)}
              aria-label="Expand the inbox"
              title="Expand the inbox"
            >
              <PanelLeftOpen className="h-3.5 w-3.5" />
            </Button>
          ) : query === null ? (
            <>
              <span data-tauri-drag-region className="min-w-0 flex-1 truncate px-1 text-[14px] font-semibold">
                <span className="titlebar-hide">Bots</span>
              </span>
              {/* The inbox below is this workspace's team (D-87). Switching
                  reloads /bots rather than the dashboard, so the simple view
                  stays the simple view. */}
              <WorkspaceSwitcher variant="compact" returnTo="/bots" />
              <Button size="icon-sm" variant="secondary" className="shrink-0 rounded-full" onClick={() => setQuery("")} aria-label="Search bots" title="Search">
                <Search className="h-3.5 w-3.5" />
              </Button>
              <Button size="icon-sm" variant="secondary" className="shrink-0 rounded-full" onClick={() => setCreating(true)} aria-label="New bot" title="New bot">
                <Plus className="h-4 w-4" />
              </Button>
            </>
          ) : (
            // Fixed height, the same as the buttons it replaces, so it stays
            // centred on the traffic lights. Below 768px globals.css gives every
            // input a 36px min-height (and 16px text, against iOS focus zoom),
            // which made this pill taller than the title bar; the input keeps
            // the 16px but not the min-height.
            <div className="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-full bg-card px-3">
              <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <input
                autoFocus
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => e.key === "Escape" && setQuery(null)}
                placeholder="Search"
                className="h-full min-h-0! min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-muted-foreground"
              />
              <button type="button" onClick={() => setQuery(null)} aria-label="Close search" className="text-muted-foreground hover:text-foreground">
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          )}
        </div>

        <nav className="min-h-0 flex-1 space-y-0.5 overflow-y-auto px-2 pb-2">
          {isLoading && <Loader2 className="mx-auto my-6 h-4 w-4 animate-spin text-muted-foreground" />}
          {visible?.map((b) => (
            <InboxRow
              key={b.id}
              bot={b}
              collapsed={!inboxOpen}
              active={b.id === selected?.id}
              unread={b.id !== selected?.id && (isUnread(b, seen[b.id]) || b.needsInput)}
              onSelect={() => setSelectedId(b.id)}
              onRename={() => setRenaming(b)}
              onDelete={() => setDeleting(b)}
            />
          ))}
          {inboxOpen && q && visible?.length === 0 && (
            <p className="px-3 py-6 text-center text-[12px] text-muted-foreground">No bots match “{query}”.</p>
          )}
        </nav>

        <div
          className={cn(
            "flex h-14 shrink-0 items-center border-t border-border",
            inboxOpen ? "px-3" : "justify-center px-2",
          )}
        >
          {/* Nexus is run from here (spec 39): settings open over it. */}
          <button
            type="button"
            onClick={() => setPanel({ kind: "settings", tab: null })}
            className={cn(
              "flex items-center gap-2 rounded-full py-1.5 text-[12.5px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground",
              inboxOpen ? "px-2" : "px-2.5",
            )}
            title="Nexus settings"
            aria-label="Nexus settings"
          >
            <Settings className="h-3.5 w-3.5" />
            {inboxOpen && "Settings"}
          </button>
          {inboxOpen && (
            <Button
              size="icon-sm"
              variant="ghost"
              className="ml-auto rounded-full"
              onClick={() => showInbox(false)}
              aria-label="Collapse the inbox"
              title="Collapse the inbox"
            >
              <PanelLeftClose className="h-3.5 w-3.5" />
            </Button>
          )}
        </div>
      </aside>

      {selected ? (
        <BotWorkspace
          key={selected.id}
          bot={selected}
          seenAt={seen[selected.id] ?? null}
          onSeen={(at) => markSeen(selected.id, at)}
          onDeleted={() => setSelectedId(null)}
          team={bots ?? []}
          onOpenBot={setSelectedId}
        />
      ) : (
        !isLoading && <EmptyTeam onCreate={() => setCreating(true)} />
      )}

      <NewBotDialog open={creating} onOpenChange={setCreating} onCreated={(id) => setSelectedId(id)} />
      <Dialog open={panel !== null} onOpenChange={closePanel}>
        <DialogContent className="flex h-[min(88vh,860px)] flex-col gap-0 overflow-hidden p-5 sm:max-w-[min(1120px,94vw)]">
          <DialogTitle className="sr-only">
            {panel?.kind === "vault" ? "Vault" : panel?.kind === "apps" ? "Connect apps" : "Settings"}
          </DialogTitle>
          {/* Keyed so switching from one panel to another starts on its own section. */}
          {panel && <SettingsPanel key={panel.kind} panel={panel.kind} initialTab={panel.tab} />}
        </DialogContent>
      </Dialog>
      {/* Keyed so the field starts from whichever bot was right-clicked,
          without an effect that writes state on open. */}
      <RenameBotDialog key={renaming?.id ?? "none"} bot={renaming} onClose={() => setRenaming(null)} />
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={`Delete ${deleting?.name ?? "this bot"}?`}
        description="Its computer and chat history go with it."
        confirmLabel="Delete bot"
        onConfirm={() => deleting && remove.mutate(deleting.id)}
      />
    </div>
  );
}

/** Rename from the inbox, without opening the bot's settings. */
function RenameBotDialog({ bot, onClose }: { bot: BotListItem | null; onClose: () => void }) {
  const [name, setName] = useState(bot?.name ?? "");
  const qc = useQueryClient();
  const { toast } = useToast();
  const save = useMutation({
    mutationFn: (next: string) => updateBot(bot!.id, { name: next }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["bots"] });
      onClose();
    },
    onError: (err) =>
      toast({
        title: "Could not rename the bot",
        description: err instanceof Error ? err.message : undefined,
        variant: "destructive",
      }),
  });
  const trimmed = name.trim();
  return (
    <Dialog open={bot !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-[420px]">
        <DialogHeader>
          <DialogTitle>Rename bot</DialogTitle>
        </DialogHeader>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (trimmed && trimmed !== bot?.name) save.mutate(trimmed);
            else onClose();
          }}
        >
          <Input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Name"
            maxLength={60}
          />
          <DialogFooter className="mt-4">
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={!trimmed || save.isPending}>
              {save.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function InboxRow({
  bot,
  collapsed,
  active,
  unread,
  onSelect,
  onRename,
  onDelete,
}: {
  bot: BotListItem;
  /** The rail: just the face, with its name in the tooltip. */
  collapsed: boolean;
  active: boolean;
  unread: boolean;
  onSelect: () => void;
  onRename: () => void;
  onDelete: () => void;
}) {
  const working = bot.activity === "working" || bot.activity === "starting";
  const asleep = bot.activity === "off";
  const qc = useQueryClient();
  const { toast } = useToast();
  const refresh = () => qc.invalidateQueries({ queryKey: ["bots"] });
  const failed = (title: string) => (err: unknown) =>
    toast({ title, description: err instanceof Error ? err.message : undefined, variant: "destructive" });
  const wake = useMutation({
    mutationFn: () => startBotComputer(bot.id),
    onSuccess: refresh,
    onError: failed("Could not wake the computer"),
  });
  const sleep = useMutation({
    mutationFn: () => stopBotComputer(bot.id),
    onSuccess: refresh,
    onError: failed("Could not put the computer to sleep"),
  });
  return (
    <ContextMenu>
      <ContextMenuTrigger
        render={
          <button
            type="button"
            onClick={onSelect}
            title={collapsed ? bot.name : undefined}
            className={cn(
              "group flex w-full items-center rounded-xl text-left transition-colors",
              collapsed ? "justify-center px-0 py-1.5" : "gap-3 px-2.5 py-2",
              active ? "bg-accent" : "hover:bg-accent/50",
            )}
          />
        }
      >
        <span className="relative shrink-0">
          <BotAvatar
            shape={bot.shape}
            color={bot.color}
            size={collapsed ? 34 : 38}
            sleeping={asleep}
            looking={active}
          />
          {collapsed && unread && (
            <span
              className="absolute -top-0.5 -right-0.5 h-2.5 w-2.5 rounded-full bg-sky-500 ring-2 ring-sidebar"
              aria-label="Unread"
            />
          )}
        </span>
        {!collapsed && (
          <>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13.5px]">{bot.name}</span>
              <span className={cn("block truncate text-[12px]", working ? "text-sky-400" : "text-muted-foreground")}>
                {working ? (bot.activity === "starting" ? "Waking up…" : "Working…") : (bot.preview ?? bot.role ?? "No messages yet")}
              </span>
            </span>
            {unread && <span className="h-2 w-2 shrink-0 rounded-full bg-sky-500" aria-label="Unread" />}
          </>
        )}
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onClick={onSelect}>
          <MessageSquare />
          Open chat
        </ContextMenuItem>
        <ContextMenuSeparator />
        {asleep ? (
          <ContextMenuItem disabled={wake.isPending} onClick={() => wake.mutate()}>
            <Play />
            Wake the computer
          </ContextMenuItem>
        ) : (
          <ContextMenuItem disabled={sleep.isPending} onClick={() => sleep.mutate()}>
            <PowerOff />
            Put the computer to sleep
          </ContextMenuItem>
        )}
        <ContextMenuSeparator />
        <ContextMenuItem onClick={onRename}>
          <Pencil />
          Rename…
        </ContextMenuItem>
        <ContextMenuItem variant="destructive" onClick={onDelete}>
          <Trash2 />
          Delete bot
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

function EmptyTeam({ onCreate }: { onCreate: () => void }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-5 p-10 text-center">
      <BotAvatar shape="blob" color="#ec4899" size={84} />
      <div className="max-w-md space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight">Meet your first bot</h1>
        <p className="text-sm text-muted-foreground">
          An AI teammate with its own computer. Ask it for something, watch it work in its browser,
          and take control whenever you need to.
        </p>
      </div>
      <Button onClick={onCreate} className="rounded-full px-4">
        <Plus className="h-4 w-4" />
        Create a bot
      </Button>
    </div>
  );
}

// ---- One bot ----------------------------------------------------------------------

function BotWorkspace({
  bot,
  seenAt,
  onSeen,
  onDeleted,
  team,
  onOpenBot,
}: {
  bot: BotListItem;
  seenAt: string | null;
  onSeen: (at: string | null) => void;
  onDeleted: () => void;
  /** Every bot, for teammate messages (avatars, names, links). */
  team: BotListItem[];
  onOpenBot: (id: string) => void;
}) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const feedKey = ["bot-feed", bot.id];
  // The screen opens as a dialog unless you anchor it: full height right of
  // the chat, or under the bot's details in the panel. The choice is per bot
  // and off by default — only some bots work in a browser — and this component
  // is keyed by bot id, so the state starts fresh on each one.
  const [panelOpen, setPanelOpen] = useState(() => readJson(BOTS_KEYS.panel, true));
  const [dockMode, setDockMode] = useState<DockMode>(() =>
    dockModeFor(readJson(BOTS_KEYS.dock, {}), bot.id),
  );
  const [panelWidth, setPanelWidth] = useState(() =>
    clampPanelWidth(readJson(BOTS_KEYS.panelWidth, PANEL_DEFAULT_WIDTH)),
  );
  const [dockWidth, setDockWidth] = useState(() =>
    typeof window === "undefined"
      ? DOCK_DEFAULT_WIDTH
      : clampDockWidth(readJson(BOTS_KEYS.dockWidth, DOCK_DEFAULT_WIDTH), window.innerWidth),
  );
  const [computerOpen, setComputerOpen] = useState(false);
  // A project chat's right panel is its sandbox (spec 39): it opens by itself
  // once there is one, and stays as the user leaves it after that.
  const projectSandboxes = useProjectSandboxes(bot.kind === "nexus" ? bot.projectId : null);
  // It opens by itself only while a sandbox is being set up (its setup log);
  // otherwise "Details" opens it.
  const booting = (projectSandboxes.data ?? []).some((s) => s.status === "provisioning" || s.status === "pending");
  // The right column: the sandbox (by itself once there is one) or Details.
  const [pane, setPane] = useState<"sandbox" | "none" | null>(null);
  const shownPane = bot.projectId ? (pane ?? (booting ? "sandbox" : "none")) : "none";
  // A surface something asked the panel to open (the floating card), and
  // whether the panel is expanded over the chat.
  const [surfaceAsk, setSurfaceAsk] = useState<{ kind: SurfaceKind; at: number } | null>(null);
  const [cardOpen, setCardOpen] = useState(false);
  // A wide chat keeps the project card pinned at its top right (and leaves it
  // room); a narrow one shows it as a popover from the chat's name.
  const [chatWidth, setChatWidth] = useState(0);
  const chatObserver = useRef<ResizeObserver | null>(null);
  const chatColumnRef = useCallback((el: HTMLDivElement | null) => {
    chatObserver.current?.disconnect();
    if (!el) return;
    chatObserver.current = new ResizeObserver(([entry]) => setChatWidth(Math.round(entry!.contentRect.width)));
    chatObserver.current.observe(el);
  }, []);
  const pinCard = Boolean(bot.projectId) && chatWidth >= 980;
  const [sandboxExpanded, setSandboxExpanded] = useState(false);
  // Frozen when the chat opens, so the NEW line stays put while you read.
  const [seenAtOpen] = useState(seenAt);

  const { data: feed } = useQuery({
    queryKey: feedKey,
    queryFn: () => getBotFeed(bot.id),
    refetchInterval: (q) => {
      const d = q.state.data as BotFeed | undefined;
      const live =
        d?.session?.status === "starting" ||
        d?.runs.some((r) => r.status === "queued" || r.status === "running");
      return live ? 1500 : 5000;
    },
  });

  // Reading the chat marks its latest message seen.
  useEffect(() => {
    onSeen(bot.previewAt);
  }, [bot.previewAt]); // eslint-disable-line react-hooks/exhaustive-deps

  const firstUnreadId = seenAtOpen
    ? (feed?.runs.find((r) => r.finishedAt && new Date(r.finishedAt) > new Date(seenAtOpen))?.id ?? null)
    : null;

  // Driving the computer is remembered above the screen, so moving it between
  // the dialog and the dock does not quietly hand it back to the bot.
  const control = useComputerControl(feed?.session?.id ?? null);

  const showPanel = (next: boolean) => {
    setPanelOpen(next);
    writeJson(BOTS_KEYS.panel, next);
  };
  /** Where the screen lives. Leaving the anchored screen while driving hands
   *  the computer back, the same as closing it. */
  const anchorScreen = (mode: DockMode) => {
    if (dockMode === "right" && mode !== "right" && control.inControl) {
      control.release();
      onHandBack();
    }
    setDockMode(mode);
    writeJson(BOTS_KEYS.dock, rememberDockMode(readJson(BOTS_KEYS.dock, {}), bot.id, mode));
    // Anchoring takes the screen out of the dialog, and the panel is where the
    // "under the details" one lives, so it has to be open.
    if (mode !== "off") setComputerOpen(false);
    if (mode === "right") showPanel(false);
    if (mode === "panel") showPanel(true);
  };
  const togglePanel = () => {
    // Closing the panel takes its screen with it.
    if (panelOpen && dockMode === "panel") anchorScreen("off");
    else showPanel(!panelOpen);
  };

  // A dragged width is written back once the drag settles, not 60 times a second.
  useEffect(() => {
    const t = setTimeout(() => writeJson(BOTS_KEYS.dockWidth, dockWidth), 300);
    return () => clearTimeout(t);
  }, [dockWidth]);
  useEffect(() => {
    const t = setTimeout(() => writeJson(BOTS_KEYS.panelWidth, panelWidth), 300);
    return () => clearTimeout(t);
  }, [panelWidth]);

  const refresh = () => {
    qc.invalidateQueries({ queryKey: feedKey });
    qc.invalidateQueries({ queryKey: ["bots"] });
  };
  const onError = (title: string) => (err: unknown) =>
    toast({ title, description: err instanceof Error ? err.message : undefined, variant: "destructive" });
  const start = useMutation({ mutationFn: () => startBotComputer(bot.id), onSuccess: refresh, onError: onError("Could not wake the computer") });
  const stop = useMutation({ mutationFn: () => stopBotComputer(bot.id), onSuccess: refresh, onError: onError("Could not stop the computer") });
  // A fresh computer without losing the chat (spec 37) — the usual fix for a
  // wedged desktop, and what the bot asks for itself with a restart block.
  const restart = useMutation({ mutationFn: () => restartBotComputer(bot.id), onSuccess: refresh, onError: onError("Could not restart the computer") });
  // Back from driving: the bot looks at what you did and carries on. If it is
  // already working (you took over mid-task), it sees the screen on its own.
  const handBack = useMutation({
    mutationFn: () => sendBotPrompt(bot.id, HANDBACK_PROMPT),
    onSuccess: refresh,
    onError: onError("Could not hand the computer back"),
  });
  const onHandBack = () => {
    const busy = feed?.runs.some((r) => r.status === "queued" || r.status === "running");
    if (!busy && !handBack.isPending) handBack.mutate();
  };

  // The Nexus chat (spec 39) is only a chat: no computer, no details panel.
  if (bot.kind === "nexus") {
    return (
      <div className="relative flex min-h-0 min-w-0 flex-1 overflow-hidden">
        {!(shownPane === "sandbox" && sandboxExpanded) && (
        // The chat's own column: the floating card hangs under its name and
        // stays centred on the chat, whatever the panel beside it does.
        <div ref={chatColumnRef} className="relative flex min-h-0 min-w-0 flex-1 overflow-hidden">
        <BotChat
          bot={bot}
          feed={feed}
          firstUnreadId={firstUnreadId}
          // "Details" opens the panel: terminals, files, setup log, preview, settings.
          panelOpen={shownPane === "sandbox"}
          onTogglePanel={() => setPane(shownPane === "sandbox" ? "none" : "sandbox")}
          onTitleClick={bot.projectId && !pinCard ? () => setCardOpen((v) => !v) : undefined}
          insetRight={pinCard ? 340 : 0}
          dockMode="off"
          onDockMode={() => {}}
          onOpenComputer={() => {}}
          onChange={refresh}
          team={team}
          onOpenBot={onOpenBot}
        />
        {bot.projectId && (pinCard || cardOpen) && (
          <ProjectCard
            projectId={bot.projectId}
            pinned={pinCard}
            onClose={() => setCardOpen(false)}
            onOpenSurface={(kind) => {
              setPane("sandbox");
              setSurfaceAsk({ kind, at: Date.now() });
            }}
          />
        )}
        </div>
        )}
        {bot.projectId && shownPane === "sandbox" && (
          <ProjectSandboxPanel
            projectId={bot.projectId}
            open={surfaceAsk}
            bot={bot}
            expanded={sandboxExpanded}
            onExpand={setSandboxExpanded}
            onClose={() => {
              setPane("none");
              setSandboxExpanded(false);
            }}
          />
        )}
      </div>
    );
  }

  return (
    <div className="relative flex min-h-0 min-w-0 flex-1">
      <BotChat
        bot={bot}
        feed={feed}
        firstUnreadId={firstUnreadId}
        panelOpen={panelOpen}
        onTogglePanel={togglePanel}
        dockMode={dockMode}
        onDockMode={(mode) => anchorScreen(dockMode === mode ? "off" : mode)}
        onOpenComputer={(takeControl) => {
          // "Take control of the computer" in the chat means exactly that — it
          // is the step people forget, so the button does it for them.
          if (takeControl) control.take();
          // The anchored screen to the right is already the big one.
          if (dockMode !== "right") setComputerOpen(true);
        }}
        onChange={refresh}
        team={team}
        onOpenBot={onOpenBot}
      />
      {/* The right column has two faces when the screen is anchored there: the
          screen, and the bot's details. Details does not unanchor the screen —
          it swaps what the column shows, and either side hands it back. */}
      {dockMode === "right" && !panelOpen && (
        <ComputerDock
          bot={bot}
          feed={feed}
          control={control}
          width={dockWidth}
          onWidth={setDockWidth}
          onExpand={() => {
            // Same screen, bigger frame: control and the session stay as they are.
            setDockMode("off");
            writeJson(BOTS_KEYS.dock, rememberDockMode(readJson(BOTS_KEYS.dock, {}), bot.id, "off"));
            setComputerOpen(true);
          }}
          onShowDetails={() => showPanel(true)}
          onClose={() => anchorScreen("off")}
          onHandBack={onHandBack}
          onStart={() => start.mutate()}
          onStop={() => stop.mutate()}
          onRestart={() => restart.mutate()}
          busy={start.isPending || stop.isPending || restart.isPending}
        />
      )}
      {panelOpen && (
        <div className="absolute inset-y-0 right-0 z-20 flex shadow-2xl xl:static xl:shadow-none">
          <BotPanel
            bot={bot}
            feed={feed}
            width={panelWidth}
            onWidth={setPanelWidth}
            screenAnchored={dockMode === "panel"}
            onShowScreen={dockMode === "right" ? () => showPanel(false) : undefined}
            onClose={togglePanel}
            onOpenComputer={(takeControl) => {
              if (takeControl) control.take();
              setComputerOpen(true);
            }}
            onDeleted={onDeleted}
          />
        </div>
      )}
      <ComputerDialog
        open={computerOpen && dockMode !== "right"}
        onOpenChange={setComputerOpen}
        onDock={anchorScreen}
        bot={bot}
        feed={feed}
        control={control}
        onHandBack={onHandBack}
        onStart={() => start.mutate()}
        onStop={() => stop.mutate()}
        onRestart={() => restart.mutate()}
        busy={start.isPending || stop.isPending || restart.isPending}
      />
    </div>
  );
}
