"use client";

// The bot's computer: the card in the bot panel (state + a live thumbnail)
// and the big view it opens, where you watch and can take control.

import { useEffect, useRef, useState, type RefObject } from "react";
import {
  ClipboardCopy,
  ClipboardPaste,
  ExternalLink,
  Hand,
  Loader2,
  MousePointerClick,
  Power,
  PowerOff,
} from "lucide-react";

import { BotAvatar } from "@/components/bots/bot-avatar";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { touchBotComputer, type BotFeed, type BotListItem } from "@/services/bots";

const HEARTBEAT_MS = 60_000;

export type ComputerState = "asleep" | "waking" | "awake" | "working" | "error";

export function computerState(feed: BotFeed | undefined): ComputerState {
  const s = feed?.session?.status;
  if (s === "starting") return "waking";
  if (s === "error") return "error";
  if (s === "ready") return feed!.runs.some((r) => r.status === "running") ? "working" : "awake";
  return "asleep";
}

export const COMPUTER_LABEL: Record<ComputerState, string> = {
  asleep: "Asleep",
  waking: "Waking up…",
  awake: "Awake",
  working: "Working",
  error: "Could not start",
};

/**
 * The remote screen. View-only until `inControl`; control flips over
 * postMessage. `allow` lets the page bridge the clipboard (⌘C / ⌘V).
 */
function Screen({
  url,
  inControl,
  className,
  frameRef,
}: {
  url: string;
  inControl: boolean;
  className?: string;
  frameRef?: RefObject<HTMLIFrameElement | null>;
}) {
  const ownRef = useRef<HTMLIFrameElement | null>(null);
  const ref = frameRef ?? ownRef;
  const push = () => ref.current?.contentWindow?.postMessage({ viewOnly: !inControl }, "*");
  useEffect(push, [inControl]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <iframe
      ref={ref}
      src={url}
      onLoad={push}
      title="Bot computer"
      allow="clipboard-read; clipboard-write"
      className={cn("h-full w-full border-0", !inControl && "pointer-events-none", className)}
    />
  );
}

/** The latest text copied on the bot's computer, as its screen page reports it. */
function useRemoteClipboard(frameRef: RefObject<HTMLIFrameElement | null>, active: boolean) {
  const [text, setText] = useState<string | null>(null);
  useEffect(() => {
    if (!active) return;
    const onMessage = (e: MessageEvent) => {
      if (e.source !== frameRef.current?.contentWindow) return;
      if (e.data?.type === "nexux-clipboard" && typeof e.data.text === "string") setText(e.data.text);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [frameRef, active]);
  return text;
}

export function ComputerCard({
  bot,
  feed,
  onOpen,
}: {
  bot: BotListItem;
  feed: BotFeed | undefined;
  onOpen: () => void;
}) {
  const state = computerState(feed);
  const url = feed?.session?.vncUrl ?? null;
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex w-full items-center gap-3 rounded-xl border border-border bg-card/60 px-3 py-2.5 text-left transition-colors hover:bg-card"
    >
      <span className="min-w-0 flex-1">
        <span className="block text-[13px]">Bot&apos;s computer</span>
        <span
          className={cn(
            "block text-[11.5px]",
            state === "working" ? "text-sky-400" : state === "error" ? "text-destructive" : "text-muted-foreground",
          )}
        >
          {COMPUTER_LABEL[state]}
        </span>
      </span>
      <span className="relative flex h-10 w-16 shrink-0 items-center justify-center overflow-hidden rounded-md bg-muted">
        {url ? (
          // A live miniature: the real screen, scaled down, never interactive.
          <span className="pointer-events-none absolute top-0 left-0 h-[400%] w-[400%] origin-top-left scale-25">
            <Screen url={url} inControl={false} />
          </span>
        ) : state === "waking" ? (
          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
        ) : (
          <>
            <BotAvatar shape={bot.shape} color="#a1a1aa" size={22} sleeping className="opacity-70" />
            <span className="absolute top-0.5 right-1.5 text-[8px] font-semibold text-muted-foreground">z</span>
          </>
        )}
      </span>
    </button>
  );
}

export function ComputerDialog({
  open,
  onOpenChange,
  bot,
  feed,
  onHandBack,
  onStart,
  onStop,
  busy,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  bot: BotListItem;
  feed: BotFeed | undefined;
  /** You were driving and stopped (Give back control, or closed the screen). */
  onHandBack: () => void;
  onStart: () => void;
  onStop: () => void;
  busy: boolean;
}) {
  const state = computerState(feed);
  const session = feed?.session ?? null;
  const url = session?.vncUrl ?? null;
  // Control is per opening and per session: a new computer starts watched.
  const [controlFor, setControlFor] = useState<string | null>(null);
  const inControl = open && Boolean(url) && controlFor !== null && controlFor === session?.id;
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const remoteClip = useRemoteClipboard(frameRef, open);

  // Your time on the screen is activity: without this the idle reaper only
  // counts chat messages, and deletes the computer while you are using it.
  const live = open && Boolean(url);
  useEffect(() => {
    if (!live) return;
    const beat = () => void touchBotComputer(bot.id).catch(() => {});
    beat();
    const timer = setInterval(beat, HEARTBEAT_MS);
    return () => clearInterval(timer);
  }, [live, bot.id]);
  const [pasting, setPasting] = useState(false);
  const [pasteText, setPasteText] = useState("");
  const [copied, setCopied] = useState(false);
  const [confirmStop, setConfirmStop] = useState(false);

  const sendPaste = () => {
    if (!pasteText) return;
    frameRef.current?.contentWindow?.postMessage({ type: "nexux-paste", text: pasteText }, "*");
    setPasteText("");
    setPasting(false);
    frameRef.current?.focus();
  };
  const copyRemote = async () => {
    if (!remoteClip) return;
    try {
      await navigator.clipboard.writeText(remoteClip);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard blocked: nothing else to do from here
    }
  };

  return (
    <>
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) {
          // Closing the screen while driving hands the computer back too.
          if (inControl) onHandBack();
          setControlFor(null);
        }
        onOpenChange(o);
      }}
    >
      <DialogContent
        showCloseButton={false}
        className="gap-0 overflow-hidden p-0 sm:max-w-[min(1180px,calc(100vw-4rem))]"
      >
        <div className="flex items-center gap-2.5 border-b border-border px-4 py-3">
          <BotAvatar shape={bot.shape} color={bot.color} size={24} sleeping={state === "asleep"} />
          <DialogTitle className="text-[13.5px] font-semibold">{bot.name}&apos;s computer</DialogTitle>
          <span
            className={cn(
              "text-[11.5px]",
              inControl ? "text-amber-400" : state === "working" ? "text-sky-400" : "text-muted-foreground",
            )}
          >
            {inControl ? "You're in control" : COMPUTER_LABEL[state]}
          </span>
          {session?.runsOn && state !== "asleep" && (
            <span
              className="rounded border border-border/60 px-1.5 py-0.5 text-[10px] text-muted-foreground"
              title={
                session.runsOn.kind === "remote"
                  ? `On ${session.runsOn.label} — its files and sign-ins live there, and this screen comes through an SSH forward.`
                  : `On ${session.runsOn.label}.`
              }
            >
              {session.runsOn.kind === "remote" ? `remote · ${session.runsOn.label}` : "local"}
            </span>
          )}
          <div className="ml-auto flex items-center gap-1.5">
            {url && (
              <Button
                size="sm"
                variant={inControl ? "default" : "secondary"}
                className="rounded-full px-3"
                onClick={() => {
                  if (!inControl) {
                    setControlFor(session?.id ?? null);
                    return;
                  }
                  // Done: the bot checks what you did, and the screen closes.
                  setControlFor(null);
                  onHandBack();
                  onOpenChange(false);
                }}
              >
                {inControl ? <MousePointerClick className="h-3.5 w-3.5" /> : <Hand className="h-3.5 w-3.5" />}
                {inControl ? "Give back control" : "Take control"}
              </Button>
            )}
            {session?.vncFullUrl && (
              <Button
                size="icon-sm"
                variant="ghost"
                title="Open in a new tab (clipboard, extra keys)"
                aria-label="Open in a new tab"
                render={<a href={session.vncFullUrl} target="_blank" rel="noreferrer" />}
              >
                <ExternalLink className="h-3.5 w-3.5" />
              </Button>
            )}
            {state === "asleep" || state === "error" ? (
              <Button size="sm" variant="secondary" className="rounded-full px-3" onClick={onStart} disabled={busy}>
                <Power className="h-3.5 w-3.5" />
                Wake up
              </Button>
            ) : (
              <Button
                size="icon-sm"
                variant="ghost"
                title="Put to sleep (deletes the computer)"
                aria-label="Put the computer to sleep"
                disabled={busy}
                onClick={() => setConfirmStop(true)}
              >
                <PowerOff className="h-3.5 w-3.5" />
              </Button>
            )}
          </div>
        </div>

        <div className="bg-black/40 p-3">
          <div
            className={cn(
              "relative mx-auto aspect-[16/10] max-h-[calc(100vh-11rem)] w-full overflow-hidden rounded-lg bg-[#0a0a0c]",
              inControl && "ring-2 ring-amber-400/70",
            )}
          >
            {url ? (
              <Screen url={url} inControl={inControl} frameRef={frameRef} className="absolute inset-0" />
            ) : (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 p-6 text-center">
                {state === "waking" ? (
                  <>
                    <Loader2 className="h-5 w-5 animate-spin text-white/60" />
                    <p className="text-xs text-white/70">Waking up a fresh computer with Chromium…</p>
                    <p className="max-w-sm text-[11px] text-white/40">
                      The first time also builds its image, which can take 10–20 minutes on a slow
                      connection.
                    </p>
                    {session?.progress && (
                      <p className="max-w-md break-words font-mono text-[10px] text-white/40">{session.progress}</p>
                    )}
                  </>
                ) : (
                  <>
                    <BotAvatar shape={bot.shape} color={bot.color} size={56} sleeping />
                    <p className="text-xs text-white/70">
                      {state === "error" ? (session?.error ?? "The computer could not start.") : "Asleep"}
                    </p>
                    <p className="max-w-sm text-[11px] text-white/40">
                      It wakes up by itself when you send a message, and is deleted after{" "}
                      {feed?.bot.idleMinutes ?? 30} idle minutes.
                    </p>
                  </>
                )}
              </div>
            )}
          </div>
        </div>
        {url && (
          <div className="flex min-h-10 items-center gap-3 border-t border-border px-4 py-2 text-[11px] text-muted-foreground">
            {pasting ? (
              <form
                className="flex flex-1 items-center gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  sendPaste();
                }}
              >
                <input
                  autoFocus
                  value={pasteText}
                  onChange={(e) => setPasteText(e.target.value)}
                  onKeyDown={(e) => e.key === "Escape" && setPasting(false)}
                  placeholder="Text to paste where the cursor is on the computer"
                  className="h-7 min-w-0 flex-1 rounded-md border border-input bg-transparent px-2 text-[12px] text-foreground outline-none focus:border-ring"
                />
                <Button type="submit" size="sm" variant="secondary" className="rounded-full px-3" disabled={!pasteText}>
                  Paste
                </Button>
                <Button type="button" size="sm" variant="ghost" onClick={() => setPasting(false)}>
                  Cancel
                </Button>
              </form>
            ) : (
              <>
                <span className="min-w-0 flex-1 truncate">
                  {inControl
                    ? state === "working"
                      ? "The bot is still working. Stop it in the chat if you need the mouse to yourself."
                      : "Your mouse and keyboard drive this computer. ⌘C and ⌘V copy and paste between your Mac and it."
                    : "Watching live. Take control to click and type, for example to sign in."}
                </span>
                {inControl && (
                  <>
                    {remoteClip && (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 max-w-[16rem] gap-1.5 px-2 text-[11.5px]"
                        title={remoteClip}
                        onClick={copyRemote}
                      >
                        <ClipboardCopy className="h-3.5 w-3.5 shrink-0" />
                        <span className="truncate">{copied ? "Copied" : `Copy “${remoteClip}”`}</span>
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 gap-1.5 px-2 text-[11.5px]"
                      onClick={() => setPasting(true)}
                    >
                      <ClipboardPaste className="h-3.5 w-3.5" />
                      Paste text
                    </Button>
                  </>
                )}
              </>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
    <ConfirmDialog
      open={confirmStop}
      onOpenChange={setConfirmStop}
      title="Delete this computer?"
      description="Anything on it is lost and running work stops."
      confirmLabel="Put to sleep"
      onConfirm={onStop}
    />
    </>
  );
}
