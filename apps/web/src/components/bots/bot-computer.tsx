"use client";

// The bot's computer: the card in the bot panel (state + a live thumbnail) and
// the screen it opens, where you watch and can take control. That screen lives
// either in a big dialog or anchored to the right of the chat (D-94), so you
// can keep typing while you watch.

import { useEffect, useRef, useState, type RefObject } from "react";
import {
  ClipboardCopy,
  ClipboardPaste,
  ExternalLink,
  Hand,
  Info,
  Loader2,
  Maximize2,
  MousePointerClick,
  PanelBottom,
  PanelRight,
  Power,
  PowerOff,
  RotateCcw,
  X,
} from "lucide-react";

import { BotAvatar } from "@/components/bots/bot-avatar";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ResizeHandle } from "@/components/ui/resize-handle";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { DOCK_DEFAULT_WIDTH, clampDockWidth, type DockMode } from "@/lib/bot-layout";
import { cn } from "@/lib/utils";
import { touchBotComputer, type BotFeed, type BotListItem } from "@/services/bots";
import { openExternal } from "@/services/updates";

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
 * The remote screen, whole, at whatever size its box is. The desktop's own
 * pixels (`screen`) are the iframe's size and CSS scales it down to fit:
 * noVNC rescales itself only when the *window* resizes, so a screen inside a
 * panel that resizes on its own was cropping instead of fitting. Scaling the
 * element is also what keeps clicks landing where they look like they land —
 * the browser maps pointer coordinates through the transform.
 *
 * View-only until `inControl`; control flips over postMessage. `allow` lets
 * the page bridge the clipboard (⌘C / ⌘V).
 */
function Screen({
  url,
  screen,
  inControl,
  className,
  frameRef,
}: {
  url: string;
  screen: { width: number; height: number };
  inControl: boolean;
  className?: string;
  frameRef?: RefObject<HTMLIFrameElement | null>;
}) {
  const ownRef = useRef<HTMLIFrameElement | null>(null);
  const ref = frameRef ?? ownRef;
  const boxRef = useRef<HTMLDivElement | null>(null);
  const [scale, setScale] = useState(0);
  const push = () => ref.current?.contentWindow?.postMessage({ viewOnly: !inControl }, "*");
  useEffect(push, [inControl]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    const fit = () => {
      const { width, height } = box.getBoundingClientRect();
      if (!width || !height) return; // folded away: keep the last fit
      setScale(Math.min(width / screen.width, height / screen.height));
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(box);
    return () => observer.disconnect();
  }, [screen.width, screen.height]);
  return (
    <div ref={boxRef} className={cn("relative h-full w-full overflow-hidden", className)}>
      <iframe
        ref={ref}
        src={url}
        onLoad={push}
        title="Bot computer"
        allow="clipboard-read; clipboard-write"
        style={{
          width: screen.width,
          height: screen.height,
          transform: `translate(-50%, -50%) scale(${scale})`,
          // Hidden until the first measurement, so it never flashes full size.
          visibility: scale ? "visible" : "hidden",
        }}
        className={cn("absolute top-1/2 left-1/2 border-0", !inControl && "pointer-events-none")}
      />
    </div>
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

/**
 * The computer in the bot's panel: a row with its state, which opens the big
 * screen. Anchored here (`anchored`), it unfolds into the space under the
 * bot's details as a live screen. That screen stays inert — a click in a
 * 380px panel would land on whatever the bot is doing — so clicking it opens
 * the big screen, and driving happens there or anchored to the chat.
 */
export function ComputerCard({
  bot,
  feed,
  anchored,
  onOpen,
}: {
  bot: BotListItem;
  feed: BotFeed | undefined;
  /** The screen is kept here, under the details. */
  anchored: boolean;
  /** Show the big screen; with `true`, take control of it at the same time. */
  onOpen: (takeControl?: boolean) => void;
}) {
  const state = computerState(feed);
  const session = feed?.session ?? null;
  const url = session?.vncUrl ?? null;
  const unfolded = Boolean(url) && anchored;
  return (
    <div className="overflow-hidden rounded-xl border border-border bg-card/60">
      <button
        type="button"
        onClick={() => onOpen()}
        title="Open the big screen"
        className="flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors hover:bg-card"
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
          {url && session && !anchored ? (
            // A live miniature: the real screen, scaled down, never interactive.
            <Screen url={url} screen={session.screen} inControl={false} className="absolute inset-0" />
          ) : state === "waking" ? (
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
          ) : url ? (
            <Maximize2 className="h-4 w-4 text-muted-foreground" />
          ) : (
            <>
              <BotAvatar shape={bot.shape} color="#a1a1aa" size={22} sleeping className="opacity-70" />
              <span className="absolute top-0.5 right-1.5 text-[8px] font-semibold text-muted-foreground">z</span>
            </>
          )}
        </span>
      </button>
      {url && (
        // max-height, not grid-rows: a `1fr` row is capped by the scrolling
        // panel's own height, which squashed the row and clipped the screen.
        <div
          className={cn(
            "overflow-hidden transition-[max-height] duration-300 ease-out motion-reduce:transition-none",
            unfolded ? "max-h-[85vh]" : "max-h-0",
          )}
        >
          <div>
            <button
              type="button"
              onClick={() => onOpen()}
              title="Open the big screen"
              // 16:10 like the desktop, but never taller than the panel can
              // show: the screen inside letterboxes rather than being cut.
              className="group relative mx-2 block aspect-[16/10] max-h-[55vh] w-[calc(100%-1rem)] cursor-pointer overflow-hidden rounded-lg bg-[#0a0a0c]"
            >
              <Screen url={url} screen={session!.screen} inControl={false} className="absolute inset-0" />
              <span className="absolute inset-x-0 bottom-0 flex justify-center pb-2">
                <span className="flex items-center gap-1.5 rounded-full border border-white/15 bg-black/70 px-2.5 py-1 text-[11px] font-medium text-white/75 opacity-0 backdrop-blur transition group-hover:opacity-100">
                  <Maximize2 className="h-3 w-3" />
                  Open the big screen
                </span>
              </span>
            </button>
            <div className="px-2 py-1.5">
              <Button
                size="sm"
                variant="ghost"
                className="h-7 w-full gap-1.5 px-2 text-[11.5px]"
                onClick={() => onOpen(true)}
              >
                <Hand className="h-3.5 w-3.5" />
                Take control
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Who is driving the computer, kept above the screen itself so it survives
 * moving that screen between the big dialog and the right-hand dock. Control
 * is per session: a fresh computer always starts watched.
 */
export type ComputerControl = {
  inControl: boolean;
  take: () => void;
  release: () => void;
};

export function useComputerControl(sessionId: string | null | undefined): ComputerControl {
  const [controlFor, setControlFor] = useState<string | null>(null);
  return {
    inControl: Boolean(sessionId) && controlFor === sessionId,
    take: () => setControlFor(sessionId ?? null),
    release: () => setControlFor(null),
  };
}

type SurfaceProps = {
  bot: BotListItem;
  feed: BotFeed | undefined;
  control: ComputerControl;
  /** Anchored beside the chat instead of filling a dialog. */
  docked: boolean;
  /** You were driving and stopped (Give back control, or closed the screen). */
  onHandBack: () => void;
  onStart: () => void;
  onStop: () => void;
  /** Delete this computer and boot a fresh one (spec 37), keeping the chat. */
  onRestart: () => void;
  busy: boolean;
  /** Anchor the screen somewhere (from the dialog). */
  onAnchor?: (mode: Exclude<DockMode, "off">) => void;
  /** Back to the dialog (from the anchored screen). */
  onExpand?: () => void;
  /** Show the bot's details in this column instead, keeping the screen anchored. */
  onShowDetails?: () => void;
  onClose: () => void;
};

/**
 * The screen with its chrome: state, control, clipboard and the power button.
 * The same thing in the dialog and in the dock — only the frame around it and
 * what “done driving” does change.
 */
function ComputerSurface({
  bot,
  feed,
  control,
  docked,
  onHandBack,
  onStart,
  onStop,
  onRestart,
  busy,
  onAnchor,
  onExpand,
  onShowDetails,
  onClose,
}: SurfaceProps) {
  const state = computerState(feed);
  const session = feed?.session ?? null;
  const url = session?.vncUrl ?? null;
  const inControl = control.inControl && Boolean(url);
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const remoteClip = useRemoteClipboard(frameRef, true);

  // Your time on the screen is activity: without this the idle reaper only
  // counts chat messages, and puts the computer to sleep while you are using it.
  const live = Boolean(url);
  useEffect(() => {
    if (!live) return;
    const beat = () => void touchBotComputer(bot.id).catch(() => {});
    beat();
    const timer = setInterval(beat, HEARTBEAT_MS);
    return () => clearInterval(timer);
  }, [live, bot.id]);
  // A stray click on a watched screen: say why nothing happened, briefly.
  const [hinting, setHinting] = useState(false);
  const hintTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const nudge = () => {
    setHinting(true);
    if (hintTimer.current) clearTimeout(hintTimer.current);
    hintTimer.current = setTimeout(() => setHinting(false), 2600);
  };
  useEffect(() => () => void (hintTimer.current && clearTimeout(hintTimer.current)), []);
  const [pasting, setPasting] = useState(false);
  const [pasteText, setPasteText] = useState("");
  const [copied, setCopied] = useState(false);
  const [confirmStop, setConfirmStop] = useState(false);
  const [confirmRestart, setConfirmRestart] = useState(false);
  const [confirmControl, setConfirmControl] = useState(false);
  const takeControl = () => {
    control.take();
    // The next keystroke should land on the computer, not here.
    frameRef.current?.focus();
  };

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
  // Done driving: the bot checks what you did. The dialog gets out of the way;
  // the anchored screen stays, so you can keep watching while you type.
  const giveBack = () => {
    control.release();
    onHandBack();
    if (!docked) onClose();
  };

  const title = `${bot.name}'s computer`;

  return (
    <>
      <div
        className={cn(
          "flex items-center gap-2.5 border-b border-border",
          docked ? "h-14 shrink-0 px-3" : "px-4 py-3",
        )}
      >
        <BotAvatar shape={bot.shape} color={bot.color} size={24} sleeping={state === "asleep"} />
        {docked ? (
          <h2 className="truncate text-[13.5px] font-semibold">{title}</h2>
        ) : (
          <DialogTitle className="text-[13.5px] font-semibold">{title}</DialogTitle>
        )}
        <span
          className={cn(
            "shrink-0 text-[11.5px]",
            inControl ? "text-amber-400" : state === "working" ? "text-sky-400" : "text-muted-foreground",
          )}
        >
          {inControl ? "You're in control" : COMPUTER_LABEL[state]}
        </span>
        {session?.runsOn && state !== "asleep" && !docked && (
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
        <div className="ml-auto flex shrink-0 items-center gap-1.5">
          {url && (
            <Button
              size="sm"
              variant={inControl ? "default" : "secondary"}
              className="rounded-full px-3"
              onClick={() => (inControl ? giveBack() : takeControl())}
            >
              {inControl ? <MousePointerClick className="h-3.5 w-3.5" /> : <Hand className="h-3.5 w-3.5" />}
              {docked ? (inControl ? "Give back" : "Control") : inControl ? "Give back control" : "Take control"}
            </Button>
          )}
          {session?.vncFullUrl && !docked && (
            <Button
              size="sm"
              variant="ghost"
              className="rounded-full px-3"
              title="Opens this screen in your own browser, with noVNC's control bar: clipboard, Ctrl/Alt keys, fullscreen"
              // The Tauri webview does nothing with target="_blank", so the
              // sidecar hands the URL to the OS (and a browser falls back).
              onClick={() => void openExternal(session.vncFullUrl!)}
            >
              <ExternalLink className="h-3.5 w-3.5" />
              Open in browser
            </Button>
          )}
          {onShowDetails && (
            <Button
              size="icon-sm"
              variant="ghost"
              title="Show the bot's details here (the screen stays anchored)"
              aria-label="Show the bot's details"
              onClick={onShowDetails}
            >
              <Info className="h-3.5 w-3.5" />
            </Button>
          )}
          {onExpand && (
            <Button
              size="icon-sm"
              variant="ghost"
              title="Open as a big screen"
              aria-label="Open as a big screen"
              onClick={onExpand}
            >
              <Maximize2 className="h-3.5 w-3.5" />
            </Button>
          )}
          {onAnchor && (
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button size="icon-sm" variant="ghost" title="Anchor this screen" aria-label="Anchor this screen" />
                }
              >
                <PanelRight className="h-3.5 w-3.5" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-60">
                <DropdownMenuItem onClick={() => onAnchor("right")}>
                  <PanelRight />
                  Full height, right of the chat
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => onAnchor("panel")}>
                  <PanelBottom />
                  Under the bot&apos;s details
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          {state === "asleep" || state === "error" ? (
            <Button size="sm" variant="secondary" className="rounded-full px-3" onClick={onStart} disabled={busy}>
              <Power className="h-3.5 w-3.5" />
              Wake up
            </Button>
          ) : (
            <>
              <Button
                size="icon-sm"
                variant="ghost"
                title="Restart the computer (a fresh machine; the chat stays)"
                aria-label="Restart the computer"
                disabled={busy}
                onClick={() => setConfirmRestart(true)}
              >
                <RotateCcw className="h-3.5 w-3.5" />
              </Button>
              <Button
                size="icon-sm"
                variant="ghost"
                title="Put to sleep (it wakes as it was)"
                aria-label="Put the computer to sleep"
                disabled={busy}
                onClick={() => setConfirmStop(true)}
              >
                <PowerOff className="h-3.5 w-3.5" />
              </Button>
            </>
          )}
          {docked && (
            <Button
              size="icon-sm"
              variant="ghost"
              title="Close the screen"
              aria-label="Close the screen"
              onClick={onClose}
            >
              <X className="h-4 w-4" />
            </Button>
          )}
        </div>
      </div>

      <div
        className={cn(
          "bg-black/40",
          docked ? "flex min-h-0 flex-1 items-center justify-center p-2" : "p-3",
        )}
      >
        <div
          className={cn(
            "relative mx-auto aspect-[16/10] w-full overflow-hidden rounded-lg bg-[#0a0a0c]",
            docked ? "max-h-full" : "max-h-[calc(100vh-11rem)]",
            inControl && "ring-2 ring-amber-400/70",
          )}
        >
          {url ? (
            <>
              <Screen
                url={url}
                screen={session!.screen}
                inControl={inControl}
                frameRef={frameRef}
                className="absolute inset-0"
              />
              {/* Watching, the screen swallows clicks (the iframe is inert) and
                  people kept clicking it, wondering why nothing happened. This
                  layer is what they hit: a stray click answers with a hint in
                  the corner that fades, and a double-click — deliberate, and
                  never a click meant for the bot's mouse — takes control. */}
              {!inControl && (
                <button
                  type="button"
                  aria-label="Take control of the computer (double-click)"
                  title="Double-click to take control"
                  onClick={nudge}
                  onDoubleClick={() => {
                    setHinting(false);
                    setConfirmControl(true);
                  }}
                  className="absolute inset-0 cursor-default focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                >
                  <span
                    className={cn(
                      "absolute right-2 bottom-2 flex items-center gap-1.5 rounded-full bg-black/70 px-2 py-1 text-[11px] font-medium text-white/80 backdrop-blur transition-opacity duration-300",
                      hinting ? "opacity-100" : "opacity-0",
                    )}
                  >
                    <Hand className="h-3 w-3" />
                    Double-click to take control
                  </span>
                </button>
              )}
            </>
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
                    It wakes up as it was when you send a message, and goes to sleep after{" "}
                    {feed?.bot.idleMinutes ?? 30} idle minutes.
                  </p>
                </>
              )}
            </div>
          )}
        </div>
      </div>
      {url && (
        <div
          className={cn(
            "flex min-h-10 items-center gap-3 border-t border-border py-2 text-[11px] text-muted-foreground",
            docked ? "px-3" : "px-4",
          )}
        >
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
                  : "Watching live. Double-click the screen to take control, for example to sign in."}
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
      <ConfirmDialog
        open={confirmControl}
        onOpenChange={setConfirmControl}
        title="Take control of this computer?"
        description={
          state === "working"
            ? "Your mouse and keyboard start driving it while the bot is still working — stop it in the chat if you need the mouse to yourself. When you give control back, the bot looks at what you did and carries on."
            : "Your mouse and keyboard start driving it, and ⌘C / ⌘V copy and paste between your Mac and the computer. When you give control back, the bot looks at what you did and carries on."
        }
        confirmLabel="Take control"
        onConfirm={takeControl}
      />
      <ConfirmDialog
        open={confirmStop}
        onOpenChange={setConfirmStop}
        title="Put this computer to sleep?"
        description="Running work stops. Its files, open sign-ins and memory stay, and it wakes as it was with your next message."
        confirmLabel="Put to sleep"
        onConfirm={onStop}
      />
      <ConfirmDialog
        open={confirmRestart}
        onOpenChange={setConfirmRestart}
        title={`Restart ${bot.name}'s computer?`}
        description="This one is deleted and a fresh one starts. The conversation stays, and so do its files in the shared workspace and its sign-ins — anything else on the machine is lost, and work in progress stops."
        confirmLabel="Restart the computer"
        onConfirm={onRestart}
      />
    </>
  );
}

type ScreenProps = Omit<SurfaceProps, "docked" | "onAnchor" | "onExpand" | "onShowDetails" | "onClose">;

/** The big screen, over the chat. */
export function ComputerDialog({
  open,
  onOpenChange,
  onDock,
  ...surface
}: ScreenProps & {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Anchor it somewhere instead (closes this dialog). */
  onDock: (mode: Exclude<DockMode, "off">) => void;
}) {
  const { control, onHandBack } = surface;
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) {
          // Closing the screen while driving hands the computer back too.
          if (control.inControl) onHandBack();
          control.release();
        }
        onOpenChange(o);
      }}
    >
      <DialogContent
        showCloseButton={false}
        className="gap-0 overflow-hidden p-0 sm:max-w-[min(1180px,calc(100vw-4rem))]"
      >
        <ComputerSurface {...surface} docked={false} onAnchor={onDock} onClose={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  );
}

/**
 * The same screen anchored to the right of the chat, so you can watch (or
 * drive) while you keep typing. Drag its left edge to resize; the width is
 * remembered per viewer.
 */
export function ComputerDock({
  width,
  onWidth,
  onExpand,
  onShowDetails,
  onClose,
  ...surface
}: ScreenProps & {
  width: number;
  onWidth: (px: number) => void;
  /** Back to the big dialog. */
  onExpand: () => void;
  /** Swap this column for the bot's details, keeping the screen anchored. */
  onShowDetails: () => void;
  onClose: () => void;
}) {
  // Keeps a remembered width honest after the window is resized smaller.
  useEffect(() => {
    const onResize = () => onWidth(clampDockWidth(width, window.innerWidth));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [width, onWidth]);

  return (
    <aside
      style={{ width }}
      className="absolute inset-y-0 right-0 z-20 flex min-w-0 shrink-0 flex-col overflow-hidden border-l border-border bg-background shadow-2xl xl:relative xl:inset-auto xl:shadow-none"
    >
      {/* Drag region for the macOS overlay title bar, out of the buttons' way. */}
      <div data-tauri-drag-region className="titlebar-only absolute inset-x-0 top-0 h-3" />
      <ResizeHandle
        side="left"
        label="Resize the computer"
        onResize={(x) => onWidth(clampDockWidth(window.innerWidth - x, window.innerWidth))}
        onReset={() => onWidth(clampDockWidth(DOCK_DEFAULT_WIDTH, window.innerWidth))}
      />
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        <ComputerSurface
          {...surface}
          docked
          onExpand={onExpand}
          onShowDetails={onShowDetails}
          onClose={onClose}
        />
      </div>
    </aside>
  );
}
