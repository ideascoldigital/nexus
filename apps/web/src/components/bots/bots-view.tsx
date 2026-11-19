"use client";

// Bots (spec 23): AI teammates, each with its own ephemeral computer.
// An inbox of bots on the left (latest message, unread dot), the conversation
// in the middle, the bot's panel on the right (activity, computer, settings).
// The computer opens as a big live screen you can take control of.

import { useEffect, useState } from "react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Loader2, Plus, Search, X } from "lucide-react";

import { BotAvatar } from "@/components/bots/bot-avatar";
import { BotChat } from "@/components/bots/bot-chat";
import { ComputerDialog } from "@/components/bots/bot-computer";
import { BotPanel } from "@/components/bots/bot-panel";
import { NewBotDialog } from "@/components/bots/new-bot-dialog";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { HANDBACK_PROMPT } from "@/lib/bot-prompts";
import { cn } from "@/lib/utils";
import {
  getBotFeed,
  getBots,
  sendBotPrompt,
  startBotComputer,
  stopBotComputer,
  type BotFeed,
  type BotListItem,
} from "@/services/bots";

// ---- Per-viewer memory (browser storage: a convenience, never required) -------

const SEEN_KEY = "nexux:bots-seen";
const PANEL_KEY = "nexux:bots-panel";

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
  const [seen, setSeen] = useState<Record<string, string>>(() => readJson(SEEN_KEY, {}));
  const markSeen = (botId: string, at: string | null) => {
    if (!at || seen[botId] === at) return;
    const next = { ...seen, [botId]: at };
    setSeen(next);
    writeJson(SEEN_KEY, next);
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
  const [query, setQuery] = useState<string | null>(null);
  const { seen, markSeen } = useSeen();

  const { data: bots, isLoading } = useQuery({
    queryKey: ["bots"],
    queryFn: getBots,
    refetchInterval: 4000,
  });

  const selected = bots?.find((b) => b.id === selectedId) ?? bots?.[0] ?? null;
  const q = query?.trim().toLowerCase() ?? "";
  const visible = q
    ? bots?.filter((b) => `${b.name} ${b.role ?? ""} ${b.preview ?? ""}`.toLowerCase().includes(q))
    : bots;

  return (
    <div className="flex min-h-0 flex-1">
      {/* Inbox */}
      <aside className="flex w-[280px] shrink-0 flex-col border-r border-border bg-sidebar xl:w-[320px]">
        {/* Doubles as the window's title bar in the macOS app: traffic lights
            on the left, drag anywhere that is not a button. */}
        <div data-tauri-drag-region className="titlebar-inset-left flex h-14 shrink-0 items-center gap-2 px-3">
          {query === null ? (
            <>
              <span data-tauri-drag-region className="flex-1 px-1 text-[14px] font-semibold">
                <span className="titlebar-hide">Bots</span>
              </span>
              <Button size="icon-sm" variant="secondary" className="rounded-full" onClick={() => setQuery("")} aria-label="Search bots" title="Search">
                <Search className="h-3.5 w-3.5" />
              </Button>
              <Button size="icon-sm" variant="secondary" className="rounded-full" onClick={() => setCreating(true)} aria-label="New bot" title="New bot">
                <Plus className="h-4 w-4" />
              </Button>
            </>
          ) : (
            <div className="flex flex-1 items-center gap-2 rounded-full bg-card px-3 py-1.5">
              <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <input
                autoFocus
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => e.key === "Escape" && setQuery(null)}
                placeholder="Search"
                className="min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-muted-foreground"
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
              active={b.id === selected?.id}
              unread={b.id !== selected?.id && (isUnread(b, seen[b.id]) || b.needsInput)}
              onSelect={() => setSelectedId(b.id)}
            />
          ))}
          {q && visible?.length === 0 && (
            <p className="px-3 py-6 text-center text-[12px] text-muted-foreground">No bots match “{query}”.</p>
          )}
        </nav>

        <div className="flex h-14 shrink-0 items-center border-t border-border px-3">
          {/* The only way out of the simple view — kept small on purpose. */}
          <Link
            href="/"
            className="flex items-center gap-2 rounded-full px-2 py-1.5 text-[12.5px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            title="Back to the Nexus dashboard"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            Nexus dashboard
          </Link>
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
    </div>
  );
}

function InboxRow({
  bot,
  active,
  unread,
  onSelect,
}: {
  bot: BotListItem;
  active: boolean;
  unread: boolean;
  onSelect: () => void;
}) {
  const working = bot.activity === "working" || bot.activity === "starting";
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        "group flex w-full items-center gap-3 rounded-xl px-2.5 py-2 text-left transition-colors",
        active ? "bg-accent" : "hover:bg-accent/50",
      )}
    >
      <BotAvatar shape={bot.shape} color={bot.color} size={38} sleeping={bot.activity === "off"} looking={active} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13.5px]">{bot.name}</span>
        <span className={cn("block truncate text-[12px]", working ? "text-sky-400" : "text-muted-foreground")}>
          {working ? (bot.activity === "starting" ? "Waking up…" : "Working…") : (bot.preview ?? bot.role ?? "No messages yet")}
        </span>
      </span>
      {unread && <span className="h-2 w-2 shrink-0 rounded-full bg-sky-500" aria-label="Unread" />}
    </button>
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
  const [panelOpen, setPanelOpen] = useState(() => readJson(PANEL_KEY, true));
  const [computerOpen, setComputerOpen] = useState(false);
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

  const togglePanel = () => {
    const next = !panelOpen;
    setPanelOpen(next);
    writeJson(PANEL_KEY, next);
  };

  const refresh = () => {
    qc.invalidateQueries({ queryKey: feedKey });
    qc.invalidateQueries({ queryKey: ["bots"] });
  };
  const onError = (title: string) => (err: unknown) =>
    toast({ title, description: err instanceof Error ? err.message : undefined, variant: "destructive" });
  const start = useMutation({ mutationFn: () => startBotComputer(bot.id), onSuccess: refresh, onError: onError("Could not wake the computer") });
  const stop = useMutation({ mutationFn: () => stopBotComputer(bot.id), onSuccess: refresh, onError: onError("Could not stop the computer") });
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

  return (
    <div className="relative flex min-h-0 min-w-0 flex-1">
      <BotChat
        bot={bot}
        feed={feed}
        firstUnreadId={firstUnreadId}
        panelOpen={panelOpen}
        onTogglePanel={togglePanel}
        onOpenComputer={() => setComputerOpen(true)}
        onChange={refresh}
        team={team}
        onOpenBot={onOpenBot}
      />
      {panelOpen && (
        <div className="absolute inset-y-0 right-0 z-20 flex shadow-2xl xl:static xl:shadow-none">
          <BotPanel
            bot={bot}
            feed={feed}
            onClose={togglePanel}
            onOpenComputer={() => setComputerOpen(true)}
            onDeleted={onDeleted}
          />
        </div>
      )}
      <ComputerDialog
        open={computerOpen}
        onOpenChange={setComputerOpen}
        bot={bot}
        feed={feed}
        onHandBack={onHandBack}
        onStart={() => start.mutate()}
        onStop={() => stop.mutate()}
        busy={start.isPending || stop.isPending}
      />
    </div>
  );
}
