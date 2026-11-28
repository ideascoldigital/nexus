"use client";

// The conversation with one bot: grey bubbles for the bot, your messages on
// the right, centred timestamps, chips for what it did on its computer, a
// "NEW" line at the first message you had not seen, and a pill composer.

import {
  Fragment,
  memo,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { useMutation } from "@tanstack/react-query";
import { format, isToday, isYesterday } from "date-fns";
import {
  ArrowUp,
  Check,
  ChevronDown,
  Clock,
  Copy,
  FileText,
  Globe,
  Hand,
  Loader2,
  Brain,
  Mail,
  Maximize2,
  MonitorPlay,
  MoreHorizontal,
  PanelBottom,
  PanelRight,
  Paperclip,
  RotateCcw,
  Search,
  Square,
  SquareTerminal,
  Trash2,
  Wand2,
  Wrench,
  X,
} from "lucide-react";

import { BotAvatar } from "@/components/bots/bot-avatar";
import { LiveReply, RunIndicator } from "@/components/bots/run-indicator";
import { ClaudeSetupCard } from "@/components/bots/claude-setup-card";
import { isMissingClaudeToken } from "@/lib/claude-setup";
import { BotSkillsDialog, SlashMenu, useBotSkills } from "@/components/bots/bot-skills";
import { ModelPicker } from "@/components/bots/model-picker";
import { MailCard } from "@/components/bots/bot-mail-card";
import { Button } from "@/components/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { ImageLightbox, MarkdownReport } from "@/components/ui/markdown-report";
import { useToast } from "@/hooks/use-toast";
import {
  attachmentMarkdown,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS,
  splitAttachments,
  type Attachment,
} from "@/lib/bot-attachments";
import { CHOICE_LETTERS, type BotChoices } from "@/lib/bot-choices";
import { caretAllowsHistory, promptHistory, stepHistory } from "@/lib/prompt-history";
import {
  isNexusNotice,
  parseConfirmCard,
  parseCredentialCard,
  parseRunCard,
  parseSourceCard,
  type RunCommand,
} from "@/lib/nexus-cards";
import { RunCard } from "@/components/bots/run-card";
import { CredentialCard } from "@/components/bots/credential-card";
import { ConfirmCard } from "@/components/bots/confirm-card";
import { ProjectSourceCard } from "@/components/bots/project-source-card";
import { findTeammate, handoffRun, replyRun } from "@/lib/bot-handoffs";
import { mailRun, parseMailState } from "@/lib/bot-mail";
import { type DockMode } from "@/lib/bot-layout";
import { isHandback, isIntro } from "@/lib/bot-prompts";
import { restartedRun } from "@/lib/bot-restart";
import { composeSkillMessage, slashOptions, slashQuery, splitSkillCommand, type SlashOption } from "@/lib/bot-skills";
import { textOn } from "@/lib/bot-shapes";
import { routineRun, splitReply } from "@/lib/bot-routines";

// Mirrors agent-core's marker; that module is server-side.
const NEEDS_INPUT_MARKER = "NEEDS_INPUT:";
import { cn } from "@/lib/utils";
import { openExternal } from "@/services/updates";
import {
  cancelBotRun,
  clearBotContext,
  deleteBotConversation,
  restartBotComputer,
  sendBotPrompt,
  uploadBotFile,
  type BotFeed,
  type BotListItem,
  type BotRun,
  type BotStep,
  type BotThreadReply,
} from "@/services/bots";

const GAP_MS = 30 * 60_000;

function stamp(iso: string): string {
  const d = new Date(iso);
  if (isToday(d)) return `Today ${format(d, "h:mm a")}`;
  if (isYesterday(d)) return `Yesterday ${format(d, "h:mm a")}`;
  return format(d, "MMM d, h:mm a");
}

export function BotChat({
  bot,
  feed,
  firstUnreadId,
  panelOpen,
  onTogglePanel,
  dockMode,
  onDockMode,
  onOpenComputer,
  onChange,
  team,
  onOpenBot,
  onTitleClick,
  onRun,
  onOpenSettings,
  aboveComposer,
  insetRight = 0,
}: {
  /** What clicking the chat's name does instead of toggling the panel (a project chat's card). */
  onTitleClick?: () => void;
  /** A Run card's commands: start them in the panel's terminals on this Mac. */
  onRun?: (commands: RunCommand[]) => void;
  /** Open Settings on a section (a credential card's "Open in Vault"). */
  onOpenSettings?: (tab: string) => void;
  /** A live strip over the composer (a sandbox being set up). */
  aboveComposer?: ReactNode;
  /** Room kept free on the right for something pinned over the chat (a project chat's card), in px. */
  insetRight?: number;
  bot: BotListItem;
  feed: BotFeed | undefined;
  team: BotListItem[];
  onOpenBot: (id: string) => void;
  /** The first run that landed since you last looked — gets the NEW line. */
  firstUnreadId: string | null;
  panelOpen: boolean;
  onTogglePanel: () => void;
  /** Where this bot's screen is kept, if anywhere. */
  dockMode: DockMode;
  onDockMode: (mode: DockMode) => void;
  /** Show the screen; with `true`, take control of it at the same time. */
  onOpenComputer: (takeControl?: boolean) => void;
  onChange: () => void;
}) {
  const { toast } = useToast();
  const [prompt, setPrompt] = useDraft(bot.id);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  const files = usePendingFiles(bot.id);
  const [dragging, setDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const send = useMutation({
    mutationFn: (text: string) => sendBotPrompt(bot.id, text),
    onSuccess: () => {
      setPrompt("");
      onChange();
    },
    onError: (err) =>
      toast({
        title: "Could not send",
        description: err instanceof Error ? err.message : undefined,
        variant: "destructive",
      }),
  });
  const cancel = useMutation({
    mutationFn: (runId: string) => cancelBotRun(bot.id, runId),
    onSuccess: onChange,
  });
  const failed = (title: string) => (err: unknown) =>
    toast({ title, description: err instanceof Error ? err.message : undefined, variant: "destructive" });
  // The three ways to start over (spec 37), kept together in one menu because
  // picking the wrong one is the real risk: forget the conversation, swap the
  // computer, or delete the conversation.
  const clearMemory = useMutation({
    mutationFn: () => clearBotContext(bot.id),
    onSuccess: () => {
      onChange();
      toast({ title: `${bot.name} starts fresh from here`, description: "Its computer is untouched." });
    },
    onError: failed("Could not clear the memory"),
  });
  const restart = useMutation({
    mutationFn: () => restartBotComputer(bot.id),
    onSuccess: () => {
      onChange();
      toast({ title: "Starting a new computer", description: `${bot.name} keeps the conversation.` });
    },
    onError: failed("Could not restart the computer"),
  });
  const removeChat = useMutation({
    mutationFn: () => deleteBotConversation(bot.id),
    onSuccess: onChange,
    onError: failed("Could not delete the conversation"),
  });
  const [confirm, setConfirm] = useState<"restart" | "delete" | null>(null);

  // A sandbox's step-by-step notices ("· pulling …") predate the live strip
  // over the composer; older chats still hold them. Only its first and last
  // words show: the assistant saying it started, and ready / failed.
  const runs = (feed?.runs ?? []).filter((r) => !(isNexusNotice(r.prompt) && r.result?.startsWith("· ")));
  // Teammates' replies to this bot's handoffs, grouped under the run that sent them.
  const threadsByRun = new Map<string, BotThreadReply[]>();
  for (const t of feed?.threads ?? []) {
    threadsByRun.set(t.sourceRunId, [
      ...(threadsByRun.get(t.sourceRunId) ?? []),
      t,
    ]);
  }
  const runsById = new Map(runs.map((r) => [r.id, r]));
  const busy = runs.some(
    (r) => r.status === "queued" || r.status === "running",
  );
  // What the composer's Stop stops: the run going now, else the next queued.
  const activeRun =
    runs.findLast((r) => r.status === "running") ?? runs.find((r) => r.status === "queued") ?? null;
  const last = runs.at(-1);
  const cleared = bot.contextClearedAt ? new Date(bot.contextClearedAt) : null;

  // Stay pinned to the newest message.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [runs.length, last?.status, last?.steps.length]);

  // The composer grows with its text, up to a few lines.
  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [prompt]);

  // ↑ / ↓ bring back what you sent (only your own messages, not the app's).
  const history = useMemo(
    () =>
      promptHistory(
        (feed?.runs ?? [])
          .map((r) => r.prompt)
          .filter(
            (p) =>
              !isIntro(p) &&
              !isNexusNotice(p) &&
              !isHandback(p) &&
              routineRun(p) === null &&
              restartedRun(p) === null &&
              replyRun(p) === null &&
              mailRun(p) === null &&
              handoffRun(p) === null,
          )
          .map((p) => splitAttachments(p).text),
      ),
    [feed?.runs],
  );
  const [historyAt, setHistoryAt] = useState<number | null>(null);
  const historyDraft = useRef("");
  const browseHistory = (dir: -1 | 1, el: HTMLTextAreaElement): boolean => {
    if (el.selectionStart !== el.selectionEnd || !caretAllowsHistory(el.value, el.selectionStart, dir)) return false;
    const step = stepHistory(history, historyAt, dir);
    if (!step) return false;
    if (historyAt === null) historyDraft.current = prompt;
    setHistoryAt(step.index);
    const text = step.index === null ? historyDraft.current : history[step.index]!;
    setPrompt(text);
    requestAnimationFrame(() => el.setSelectionRange(text.length, text.length));
    return true;
  };

  // A skill picked from the "/" menu rides as a chip, not as text (spec 38).
  const [pickedSkill, setPickedSkill] = useState<string | null>(null);
  const submit = () => {
    if (send.isPending || files.uploading) return;
    const attached = files.ready.map(attachmentMarkdown).join("\n");
    const text = [composeSkillMessage(pickedSkill, prompt), attached].filter(Boolean).join("\n\n");
    // The attachments and the picked skill go with this message only (not with a picked option).
    if (text)
      send.mutate(text, {
        onSuccess: () => {
          files.clear();
          setPickedSkill(null);
          setHistoryAt(null);
        },
      });
  };
  const canSend =
    (prompt.trim().length > 0 || files.ready.length > 0 || pickedSkill !== null) && !files.uploading;

  // The "/" menu (spec 38): open while a command is typed alone at the start,
  // until it is picked or dismissed with Escape.
  const skills = useBotSkills(bot.id);
  // The Nexus chat (spec 39) has no computer, details panel or skills.
  const nexus = bot.kind === "nexus";
  const [skillsOpen, setSkillsOpen] = useState(false);
  // The highlighted row, for the query it was picked on: typing more resets it.
  const [slashSel, setSlashSel] = useState<{ q: string | null; i: number }>({ q: null, i: 0 });
  const [slashDismissed, setSlashDismissed] = useState<string | null>(null);
  const slash = slashQuery(prompt);
  const slashMenu =
    !nexus && slash !== null && slashDismissed !== prompt
      ? slashOptions(slash, (skills.data ?? []).filter((s) => s.loaded))
      : [];
  const slashActive = slashSel.q === slash ? slashSel.i : 0;
  const setSlashActive = (next: number | ((i: number) => number)) =>
    setSlashSel({ q: slash, i: typeof next === "function" ? next(slashActive) : next });
  const pickSlash = (o: SlashOption) => {
    if (o.kind === "skills") {
      setPrompt("");
      setSkillsOpen(true);
    } else {
      setPickedSkill(o.command);
      setPrompt("");
      inputRef.current?.focus();
    }
  };

  const addFiles = (list: Iterable<File>) => {
    const err = files.add(list);
    if (err) toast({ title: err, variant: "destructive" });
  };

  return (
    <section
      className="relative flex min-h-0 min-w-0 flex-1 flex-col"
      onDragEnter={(e) => {
        if (e.dataTransfer.types.includes("Files")) setDragging(true);
      }}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes("Files")) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false);
      }}
      onDrop={(e) => {
        if (!e.dataTransfer.files.length) return;
        e.preventDefault();
        setDragging(false);
        addFiles(e.dataTransfer.files);
        inputRef.current?.focus();
      }}
    >
      {dragging && (
        <div className="pointer-events-none absolute inset-3 z-20 flex items-center justify-center rounded-3xl border-2 border-dashed border-foreground/30 bg-background/80 text-[14px] font-medium backdrop-blur-sm">
          <Paperclip className="mr-2 h-4 w-4" />
          Drop to attach for {bot.name}
        </div>
      )}
      {/* Floating title */}
      <div className="pointer-events-none absolute inset-x-0 top-0 z-10 flex items-center gap-2 bg-gradient-to-b from-background via-background/80 to-transparent px-4 pt-3 pb-6">
        {/* The top strip drags the window in the macOS app (overlay title bar). */}
        <div
          data-tauri-drag-region
          className="titlebar-only pointer-events-auto absolute inset-x-0 top-0 h-12"
        />
        {/* The name centres in whatever room the buttons leave, and gives way
            (truncates) before it ever runs under them. */}
        <div className="flex min-w-0 flex-1 justify-center">
          <button
            type="button"
            onClick={onTitleClick ?? (nexus ? undefined : onTogglePanel)}
            data-card-toggle={onTitleClick ? "" : undefined}
            className="group pointer-events-auto flex min-w-0 items-center gap-2 rounded-full border border-border bg-card/90 py-1 pr-3.5 pl-1.5 text-[13.5px] shadow-sm backdrop-blur transition-colors hover:bg-card"
          >
            <BotAvatar shape={bot.shape} color={bot.color} size={24} />
            <span className="truncate">{bot.name}</span>
          </button>
        </div>
        <div className="pointer-events-auto relative flex shrink-0 items-center gap-1.5">
          {/* Where to keep the screen: nowhere (it opens as a dialog), beside
              the chat, or under the bot's details — so you can watch it work
              while you type. */}
          {!nexus && (
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  variant={dockMode === "off" ? "secondary" : "default"}
                  size="sm"
                  className="rounded-full px-3"
                  title="Where to keep the bot's screen"
                />
              }
            >
              <MonitorPlay className="h-3.5 w-3.5" />
              Screen
              <ChevronDown className="h-3 w-3 opacity-70" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-64">
              <DropdownMenuItem onClick={() => onOpenComputer()}>
                <Maximize2 />
                Open the big screen
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => onDockMode("right")}>
                <PanelRight />
                <span className="flex-1">Anchor right of the chat</span>
                {dockMode === "right" && <Check className="h-3.5 w-3.5 text-primary" />}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => onDockMode("panel")}>
                <PanelBottom />
                <span className="flex-1">Anchor under the details</span>
                {dockMode === "panel" && <Check className="h-3.5 w-3.5 text-primary" />}
              </DropdownMenuItem>
              {dockMode !== "off" && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={() => onDockMode("off")}>
                    <X />
                    Put the screen away
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  variant="secondary"
                  size="icon-sm"
                  className="rounded-full"
                  title="Start over"
                  aria-label="Start over"
                />
              }
            >
              <MoreHorizontal className="h-4 w-4" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-72">
              <DropdownMenuItem disabled={clearMemory.isPending} onClick={() => clearMemory.mutate()}>
                <Brain />
                <span className="flex-1">
                  Clear the memory
                  <span className="block text-[11px] text-muted-foreground">
                    It forgets this conversation; the messages stay
                  </span>
                </span>
              </DropdownMenuItem>
              {!nexus && (
              <DropdownMenuItem disabled={restart.isPending} onClick={() => setConfirm("restart")}>
                <RotateCcw />
                <span className="flex-1">
                  Restart the computer
                  <span className="block text-[11px] text-muted-foreground">
                    A fresh machine; it keeps the conversation
                  </span>
                </span>
              </DropdownMenuItem>
              )}
              <DropdownMenuSeparator />
              <DropdownMenuItem
                disabled={removeChat.isPending}
                onClick={() => setConfirm("delete")}
                className="text-destructive"
              >
                <Trash2 />
                Delete the conversation
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          {!panelOpen && (!nexus || bot.projectId) && (
            <Button variant="secondary" size="sm" className="rounded-full px-3" onClick={onTogglePanel}>
              <PanelRight className="h-3.5 w-3.5" />
              Details
            </Button>
          )}
        </div>
      </div>

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto" style={insetRight ? { paddingRight: insetRight } : undefined}>
        <div className="mx-auto w-full max-w-[960px] space-y-2.5 px-6 pt-16 pb-6">
          {feed && runs.length === 0 && (
            <div className="flex flex-col items-center gap-3 pt-20 text-center">
              <BotAvatar shape={bot.shape} color={bot.color} size={72} />
              <p className="text-[15px] font-medium">{bot.name}</p>
              <p className="max-w-sm text-[12.5px] text-muted-foreground">
                {bot.role ? `${bot.role}. ` : ""}Ask for something and{" "}
                {bot.name} wakes up its own computer and works in the browser
                while you watch.
              </p>
            </div>
          )}
          {runs.map((r, i) => {
            const prev = runs[i - 1];
            // Where the bot's memory of this chat begins (spec 37). The
            // messages above it are the user's record, not the bot's context.
            const clearedHere =
              cleared !== null &&
              new Date(r.createdAt) >= cleared &&
              (!prev || new Date(prev.createdAt) < cleared);
            const newGap =
              !prev ||
              new Date(r.createdAt).getTime() -
                new Date(prev.createdAt).getTime() >
                GAP_MS;
            const newSession = prev && prev.sessionId !== r.sessionId;
            // A picked option shows inside the question card, not as your bubble.
            const prevChoices =
              prev?.status === "completed"
                ? splitReply(prev.result).choices
                : null;
            const ownChoices =
              r.status === "completed" ? splitReply(r.result).choices : null;
            const next = runs[i + 1];
            const answer =
              ownChoices && next && ownChoices.options.includes(next.prompt)
                ? next.prompt
                : null;
            return (
              <Fragment key={r.id}>
                {r.id === firstUnreadId && (
                  <div className="flex items-center gap-3 py-2 text-[11px] font-medium text-rose-400">
                    <span className="h-px flex-1 bg-rose-400/40" />
                    NEW
                    <span className="h-px flex-1 bg-rose-400/40" />
                  </div>
                )}
                {clearedHere && <MemoryCleared />}
                {newSession && !clearedHere && (
                  <p className="py-1 text-center text-[11.5px] text-muted-foreground">
                    <MonitorPlay className="mr-1 inline h-3 w-3 align-[-2px]" />
                    New computer · fresh memory
                  </p>
                )}
                {newGap && (
                  <p className="pt-3 pb-1 text-center text-[11.5px] text-muted-foreground">
                    {stamp(r.createdAt)}
                  </p>
                )}
                <RunMessages
                  run={r}
                  bot={bot}
                  hidePrompt={Boolean(prevChoices?.options.includes(r.prompt))}
                  answer={answer}
                  canChoose={i === runs.length - 1 && !send.isPending}
                  onCancel={cancel.mutate}
                  onRetry={send.mutate}
                  onOpenComputer={onOpenComputer}
                  onChoose={(option) => send.mutate(option)}
                  team={team}
                  onOpenBot={onOpenBot}
                  threads={threadsByRun.get(r.id)}
                  runsById={runsById}
                  onChange={onChange}
                  onRun={onRun}
                  onOpenSettings={onOpenSettings}
                />
              </Fragment>
            );
          })}
          {/* Cleared and nothing said since: the line belongs at the end. */}
          {cleared !== null && last && new Date(last.createdAt) < cleared && <MemoryCleared />}
        </div>
      </div>

      <div className="shrink-0 px-6 pb-5" style={insetRight ? { paddingRight: insetRight + 24 } : undefined}>
        {aboveComposer && <div className="mx-auto w-full max-w-[960px]">{aboveComposer}</div>}
        <div className="relative mx-auto w-full max-w-[960px] rounded-2xl border border-border bg-card/70 px-3 pt-3 pb-2 shadow-sm focus-within:border-foreground/25">
          <SlashMenu
            options={slashMenu}
            active={Math.min(slashActive, Math.max(slashMenu.length - 1, 0))}
            onHover={setSlashActive}
            onPick={pickSlash}
          />
          {pickedSkill && (
            <div className="flex px-1.5 pt-1.5 pb-0.5">
              <span className="flex items-center gap-1.5 rounded-full border border-border bg-background/60 py-1 pr-1 pl-2.5 text-[12px]">
                <Wand2 className="h-3.5 w-3.5 text-muted-foreground" />
                Using <span className="font-mono">{pickedSkill}</span>
                <button
                  type="button"
                  onClick={() => setPickedSkill(null)}
                  aria-label="Don't use this skill"
                  className="flex h-5 w-5 items-center justify-center rounded-full text-muted-foreground hover:bg-accent hover:text-foreground"
                >
                  <X className="h-3 w-3" />
                </button>
              </span>
            </div>
          )}
          {files.items.length > 0 && (
            <div className="flex flex-wrap gap-2 pb-2">
              {files.items.map((f) => (
                <PendingFileChip key={f.key} file={f} onRemove={() => files.remove(f.key)} />
              ))}
            </div>
          )}
          <input
            ref={fileInputRef}
            type="file"
            multiple
            hidden
            onChange={(e) => {
              if (e.target.files) addFiles(e.target.files);
              e.target.value = "";
            }}
          />
          <textarea
            ref={inputRef}
            rows={1}
            value={prompt}
            onChange={(e) => {
              setPrompt(e.target.value);
              // Editing a recalled message makes it the draft.
              setHistoryAt(null);
            }}
            onPaste={(e) => {
              const pasted = filesFromClipboard(e.clipboardData);
              if (pasted.length === 0) return;
              // A copied screenshot has no text: keep it out of the box. A copied
              // web page brings both — its text goes in as usual.
              if (!e.clipboardData.getData("text/plain")) e.preventDefault();
              addFiles(pasted);
            }}
            onKeyDown={(e) => {
              if (slashMenu.length > 0) {
                const n = slashMenu.length;
                if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                  e.preventDefault();
                  setSlashActive((i) => (i + (e.key === "ArrowDown" ? 1 : n - 1)) % n);
                  return;
                }
                if ((e.key === "Enter" && !e.shiftKey) || e.key === "Tab") {
                  e.preventDefault();
                  pickSlash(slashMenu[Math.min(slashActive, n - 1)]);
                  return;
                }
                if (e.key === "Escape") {
                  e.preventDefault();
                  setSlashDismissed(prompt);
                  return;
                }
              }
              if (
                (e.key === "ArrowUp" || e.key === "ArrowDown") &&
                !e.shiftKey &&
                !e.altKey &&
                !e.metaKey &&
                !e.ctrlKey &&
                browseHistory(e.key === "ArrowUp" ? -1 : 1, e.currentTarget)
              ) {
                e.preventDefault();
                return;
              }
              if (e.key === "Backspace" && pickedSkill && prompt === "") {
                setPickedSkill(null);
                return;
              }
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
            placeholder={
              pickedSkill
                ? `What should ${bot.name} do with ${pickedSkill}? (or just send)`
                : busy
                  ? `${bot.name} is busy. This will run next…`
                  : nexus
                    ? ""
                    : `Message ${bot.name} — / for skills`
            }
            className="block max-h-48 min-h-[44px] w-full resize-none bg-transparent px-1 text-[13.5px] leading-5 outline-none placeholder:text-muted-foreground"
          />
          <div className="mt-1 flex items-center gap-1">
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            aria-label="Attach files"
            title="Attach files — or paste or drop them here"
            className="-ml-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <Paperclip className="h-4 w-4" />
          </button>
            <div className="flex-1" />
            <ModelPicker key={bot.id} bot={bot} />
          {/* While it works, send becomes Stop — until something is typed,
              which then queues as the next message. */}
          {activeRun && !canSend ? (
            <button
              type="button"
              onClick={() => cancel.mutate(activeRun.id)}
              disabled={cancel.isPending}
              aria-label="Stop"
              title={activeRun.status === "running" ? "Stop" : "Cancel the queued message"}
              className="flex h-8 w-8 shrink-0 animate-in items-center justify-center rounded-full text-white transition-opacity duration-200 zoom-in-75 disabled:opacity-60"
              style={{ background: bot.color }}
            >
              {cancel.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Square className="h-3 w-3 fill-current" />
              )}
            </button>
          ) : (
          <button
            type="button"
            onClick={submit}
            disabled={!canSend || send.isPending}
            aria-label="Send"
            title="Send (Enter)"
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-white transition-opacity disabled:opacity-40"
            style={{ background: bot.color }}
          >
            {send.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <ArrowUp className="h-4 w-4" />
            )}
          </button>
          )}
          </div>
        </div>
      </div>
      <BotSkillsDialog botId={bot.id} botName={bot.name} open={skillsOpen} onOpenChange={setSkillsOpen} />
      <ConfirmDialog
        open={confirm === "restart"}
        onOpenChange={(o) => !o && setConfirm(null)}
        title={`Restart ${bot.name}'s computer?`}
        description="Its current computer is deleted and a fresh one starts. The conversation stays, and so do its files in the shared workspace and its sign-ins — anything else on the machine is lost, and work in progress stops."
        confirmLabel="Restart the computer"
        onConfirm={() => restart.mutate()}
      />
      <ConfirmDialog
        open={confirm === "delete"}
        onOpenChange={(o) => !o && setConfirm(null)}
        title={`Delete the conversation with ${bot.name}?`}
        description="Every message and the files it handed over here go for good, and the bot forgets them. Its routines, its sign-ins and the shared workspace stay."
        confirmLabel="Delete the conversation"
        onConfirm={() => removeChat.mutate()}
      />
    </section>
  );
}

/**
 * Where the bot's memory of this conversation starts (spec 37). It reads like
 * the "new computer" line on purpose: both mark a point the bot cannot see
 * past, and the messages above stay because they are the user's record.
 */
function MemoryCleared() {
  return (
    <p className="py-1 text-center text-[11.5px] text-muted-foreground">
      <Brain className="mr-1 inline h-3 w-3 align-[-2px]" />
      Memory cleared · the bot starts fresh here
    </p>
  );
}

const DRAFT_KEY = "nexux:bot-draft:";

/**
 * The unsent text of one bot's composer. Kept in localStorage because the chat
 * unmounts when you open another bot or leave the page, and a half-written
 * message should still be there when you come back.
 */
function useDraft(botId: string) {
  const [text, setText] = useState(() => {
    try {
      return window.localStorage.getItem(DRAFT_KEY + botId) ?? "";
    } catch {
      return "";
    }
  });
  const set = (next: string) => {
    setText(next);
    try {
      if (next) window.localStorage.setItem(DRAFT_KEY + botId, next);
      else window.localStorage.removeItem(DRAFT_KEY + botId);
    } catch {
      // Storage unavailable: the draft just lives for this visit.
    }
  };
  return [text, set] as const;
}

const STEP_ICON: Record<string, typeof Globe> = {
  Browser: Globe,
  Web: Globe,
  Search: Search,
  Terminal: SquareTerminal,
  Files: FileText,
};

/** The one line of progress while a bot works: its latest step, replaced as it goes. */
function CurrentStep({ step }: { step: BotStep }) {
  const Icon = STEP_ICON[step.app] ?? Wrench;
  return (
    <span className="flex min-w-0 animate-in items-center gap-2 duration-300 fade-in">
      <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      <span className="min-w-0 truncate text-[12.5px]">
        <span className="font-medium text-foreground/90">{step.app}</span>{" "}
        <span className="text-muted-foreground">
          {step.action}
          {step.detail ? ` · ${step.detail}` : ""}
        </span>
      </span>
    </span>
  );
}

/** Silent on purpose: a toast for every copy would be noise in a chat. */
function copyToClipboard(text: string | null | undefined) {
  if (!text?.trim()) return;
  void navigator.clipboard?.writeText(text).catch(() => undefined);
}

function Bubble({
  children,
  className,
  /** A typing indicator has nothing worth copying. */
  copyable = true,
  /** What to copy when the bubble holds more than the reply (a button, say). */
  copyText,
}: {
  children: ReactNode;
  className?: string;
  copyable?: boolean;
  copyText?: string | null;
}) {
  // What the bubble reads as on screen, which is what "copy" should mean for
  // a reply rendered from Markdown.
  const body = useRef<HTMLDivElement>(null);
  const [copied, setCopied] = useState(false);
  const copy = () => {
    copyToClipboard(copyText ?? body.current?.innerText);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  const bubble = (
    <div
      ref={body}
      className={cn(
        "w-fit max-w-[560px] rounded-2xl bg-card px-3.5 py-2.5 text-[13.5px] leading-relaxed",
        copyable && "group/bubble relative",
        className,
      )}
    >
      {children}
      {copyable && (
        // On hover, top right — the same copy the right-click menu offers.
        <button
          type="button"
          onClick={copy}
          aria-label={copied ? "Copied" : "Copy text"}
          title={copied ? "Copied" : "Copy"}
          className={cn(
            "absolute -top-2.5 -right-2.5 flex h-6 w-6 items-center justify-center rounded-md border border-border bg-card text-muted-foreground shadow-sm transition-opacity hover:text-foreground focus-visible:opacity-100",
            copied ? "opacity-100" : "opacity-0 group-hover/bubble:opacity-100",
          )}
        >
          {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
        </button>
      )}
    </div>
  );
  if (!copyable) return bubble;
  return (
    <ContextMenu>
      <ContextMenuTrigger render={bubble} />
      <ContextMenuContent>
        <ContextMenuItem onClick={copy}>
          <Copy />
          Copy text
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

function BotTag() {
  return (
    <span className="rounded bg-muted px-1 py-px text-[9.5px] font-semibold tracking-wide text-muted-foreground">
      BOT
    </span>
  );
}

/** A message one bot wrote to another: "@Name …", with an optional thread under it. */
function BotPost({
  author,
  authorName,
  time,
  mention,
  message,
  onOpenBot,
  note,
  hideImages = false,
  children,
}: {
  author: BotListItem | null;
  authorName: string;
  time: string;
  mention: string;
  message: string;
  onOpenBot: (id: string) => void;
  note?: string;
  /** The images are already in the bot's reply above: mention them, don't repeat them. */
  hideImages?: boolean;
  children?: ReactNode;
}) {
  const images = hideImages
    ? (message.match(/!\[[^\]]*\]\([^)]*\)/g) ?? []).length
    : 0;
  const shown = hideImages
    ? message
        .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
        .replace(/\s*[:,]\s*([.;]|$)/g, "$1") // "está lista: ." → "está lista."
        .replace(/\s+([.,;])/g, "$1")
        .trim()
    : message;
  return (
    <div className="flex max-w-[620px] items-start gap-2.5">
      <button
        type="button"
        className="group mt-0.5 shrink-0"
        onClick={() => author && onOpenBot(author.id)}
        title={author ? `Open ${author.name}` : undefined}
      >
        <BotAvatar
          shape={author?.shape ?? "blob"}
          color={author?.color ?? "#71717a"}
          size={30}
        />
      </button>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-1.5">
          <span className="text-[13px] font-semibold">{authorName}</span>
          <BotTag />
          <span className="text-[11px] text-muted-foreground">
            {format(new Date(time), "h:mm a")}
          </span>
        </div>
        <div className="text-[13.5px] [&_p]:text-foreground/90">
          <MarkdownReport>{`[@${mention}](#mention) ${shown}`}</MarkdownReport>
        </div>
        {images > 0 && (
          <p className="mt-0.5 text-[11.5px] text-muted-foreground">
            📎{" "}
            {images === 1
              ? "Attached the image above"
              : `Attached the ${images} images above`}
          </p>
        )}
        {note && <p className="mt-1 text-[11.5px] text-destructive">{note}</p>}
        {children}
      </div>
    </div>
  );
}

/** A teammate's side of a handoff: "On it…" while it works, then its reply. */
function Thread({
  teammate,
  replies,
  onOpenBot,
}: {
  teammate: BotListItem;
  replies: BotThreadReply[];
  onOpenBot: (id: string) => void;
}) {
  if (replies.length === 0) return null;
  return (
    <div className="mt-2 space-y-2.5 border-l-2 border-border pl-3">
      {replies.map((r) => (
        <div key={r.id} className="flex items-start gap-2">
          <BotAvatar
            shape={teammate.shape}
            color={teammate.color}
            size={22}
            className="mt-0.5"
          />
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline gap-1.5">
              <span className="text-[12.5px] font-semibold">
                {teammate.name}
              </span>
              <BotTag />
              <span className="text-[11px] text-muted-foreground">
                {format(new Date(r.finishedAt ?? r.createdAt), "h:mm a")}
              </span>
            </div>
            {r.status === "queued" || r.status === "running" ? (
              <p className="flex items-center gap-1.5 text-[12.5px] text-muted-foreground">
                <span className="flex gap-0.5" aria-hidden>
                  {[0, 150, 300].map((d) => (
                    <span
                      key={d}
                      className="h-1 w-1 animate-bounce rounded-full bg-muted-foreground"
                      style={{ animationDelay: `${d}ms` }}
                    />
                  ))}
                </span>
                {r.status === "queued" ? "Got it, starting soon…" : "On it…"}
              </p>
            ) : r.status === "error" ? (
              <p className="text-[12.5px] text-destructive">
                {r.error ?? "Could not finish."}
              </p>
            ) : r.status === "canceled" ? (
              <p className="text-[12.5px] text-muted-foreground italic">
                Stopped.
              </p>
            ) : (
              <div className="line-clamp-6 text-[13px] [&_p]:text-foreground/90">
                <MarkdownReport variant="chat">{r.text ?? "Done."}</MarkdownReport>
              </div>
            )}
            <button
              type="button"
              onClick={() => onOpenBot(teammate.id)}
              className="mt-0.5 text-[11px] text-muted-foreground hover:text-foreground"
            >
              Open {teammate.name}&apos;s chat →
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

/** A bot's multiple-choice question: lettered options, then "Something else". */
function ChoicesCard({
  choices,
  bot,
  answer,
  disabled,
  onChoose,
}: {
  choices: BotChoices;
  bot: BotListItem;
  answer: string | null;
  disabled: boolean;
  onChoose: (option: string) => void;
}) {
  const letter = (i: number) => CHOICE_LETTERS[i] ?? "•";
  const picked = answer ? choices.options.indexOf(answer) : -1;
  const [other, setOther] = useState<string | null>(null);
  return (
    <div className="w-full max-w-[560px] rounded-2xl bg-card px-4 pt-5 pb-3">
      <p className="pb-2 text-[13.5px] font-semibold">{choices.question}</p>
      {answer !== null ? (
        <div className="flex items-center gap-3 rounded-lg py-1.5 text-[13.5px]">
          <span
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-[11px] font-semibold text-white"
            style={{ background: bot.color }}
          >
            {picked >= 0 ? letter(picked) : "•"}
          </span>
          {answer}
        </div>
      ) : (
        <div className="space-y-0.5">
          {choices.options.map((o, i) => (
            <button
              key={o}
              type="button"
              disabled={disabled}
              onClick={() => onChoose(o)}
              className="group flex w-full items-center gap-3 rounded-lg px-1 py-1.5 text-left text-[13.5px] transition-colors hover:bg-accent/60 disabled:opacity-50"
            >
              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md border border-border text-[11px] text-muted-foreground group-hover:border-foreground/30">
                {letter(i)}
              </span>
              {o}
            </button>
          ))}
          {/* "Something else" opens a field right here: type it, Enter sends. */}
          {other === null ? (
            <button
              type="button"
              disabled={disabled}
              onClick={() => setOther("")}
              className="group flex w-full items-center gap-3 rounded-lg px-1 py-1.5 text-left text-[13.5px] text-muted-foreground transition-colors hover:bg-accent/60 disabled:opacity-50"
            >
              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md border border-border text-[11px]">
                {letter(choices.options.length)}
              </span>
              Something else
            </button>
          ) : (
            <form
              className="flex w-full items-center gap-3 rounded-lg bg-accent/40 px-1 py-1"
              onSubmit={(e) => {
                e.preventDefault();
                if (other.trim()) onChoose(other.trim());
              }}
            >
              <span
                className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-[11px] font-semibold text-white"
                style={{ background: bot.color }}
              >
                {letter(choices.options.length)}
              </span>
              <input
                autoFocus
                value={other}
                disabled={disabled}
                onChange={(e) => setOther(e.target.value)}
                onKeyDown={(e) => e.key === "Escape" && setOther(null)}
                onBlur={() => !other.trim() && setOther(null)}
                placeholder="Tell it what you need…"
                className="h-7 min-w-0 flex-1 bg-transparent text-[13.5px] outline-none placeholder:text-muted-foreground"
              />
              <button
                type="submit"
                disabled={disabled || !other.trim()}
                aria-label="Send"
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-white transition-opacity disabled:opacity-40"
                style={{ background: bot.color }}
              >
                <ArrowUp className="h-3.5 w-3.5" />
              </button>
            </form>
          )}
        </div>
      )}
    </div>
  );
}

const RunMessages = memo(function RunMessages({
  run,
  bot,
  hidePrompt,
  answer,
  canChoose,
  onCancel,
  onRetry,
  onOpenComputer,
  onChoose,
  team,
  onOpenBot,
  threads,
  runsById,
  onChange,
  onRun,
  onOpenSettings,
}: {
  run: BotRun;
  bot: BotListItem;
  /** The chat's runs, to follow the run that sends each email card. */
  runsById: Map<string, BotRun>;
  onChange: () => void;
  onRun?: (commands: RunCommand[]) => void;
  onOpenSettings?: (tab: string) => void;
  team: BotListItem[];
  onOpenBot: (id: string) => void;
  threads?: BotThreadReply[];
  /** Its prompt is shown elsewhere (the option picked in the card above). */
  hidePrompt: boolean;
  /** The option the user picked from this run's question, if any. */
  answer: string | null;
  canChoose: boolean;
  onCancel: (runId: string) => void;
  /** Send the same prompt again, as a new run. */
  onRetry: (prompt: string) => void;
  onOpenComputer: (takeControl?: boolean) => void;
  onChoose: (option: string) => void;
}) {
  const reply = run.status === "completed" ? splitReply(run.result) : null;
  // Messages to teammates (with their threads) read right after the bot's
  // own words and before any question it asks you — the order things happened.
  const posts = reply?.handoffs.map((h, i) => {
    const to = findTeammate(team, h.to);
    return (
      <BotPost
        key={`h${i}`}
        author={bot}
        authorName={bot.name}
        time={run.finishedAt ?? run.createdAt}
        mention={to?.name ?? h.to}
        message={h.message}
        hideImages={Boolean(reply.body)}
        onOpenBot={onOpenBot}
        note={
          to
            ? undefined
            : `No teammate named “${h.to}”, so this was not delivered.`
        }
      >
        {to && (
          <Thread
            teammate={to}
            replies={(threads ?? []).filter((t) => t.botId === to.id)}
            onOpenBot={onOpenBot}
          />
        )}
      </BotPost>
    );
  });
  const choices = reply?.choices ?? null;
  // A project chat (spec 39) asks where the code comes from with a card.
  const source = bot.kind === "nexus" && run.status === "completed" ? parseSourceCard(reply?.body) : null;
  // …and asks before anything that costs money.
  const confirmCard = bot.kind === "nexus" && run.status === "completed" && !source ? parseConfirmCard(reply?.body) : null;
  // …and helps add a cloud key when the one picked has none.
  const credentialCard =
    bot.kind === "nexus" && run.status === "completed" && !source && !confirmCard ? parseCredentialCard(reply?.body) : null;
  // …and proposes how to run it on this Mac, without a sandbox.
  const runCard =
    bot.kind === "nexus" && run.status === "completed" && !source && !confirmCard && !credentialCard
      ? parseRunCard(reply?.body)
      : null;
  const routine = routineRun(run.prompt);
  const restarted = restartedRun(run.prompt);
  const incoming = handoffRun(run.prompt);
  const sender = incoming
    ? (team.find((b) => b.id === incoming.fromId) ?? null)
    : null;
  const answerBack = replyRun(run.prompt);
  const sending = mailRun(run.prompt);
  // The app sent it, not you (an intro, a routine, a teammate's answer coming
  // back, an email you approved on its card).
  const quiet =
    isIntro(run.prompt) ||
    isNexusNotice(run.prompt) ||
    routine !== null ||
    restarted !== null ||
    answerBack !== null ||
    sending !== null;
  const { text: sentText, attachments: attached } = splitAttachments(run.prompt);
  // "/<skill> …" shows as a chip over what you wrote.
  const { skill: usedSkill, rest: ownText } = splitSkillCommand(sentText);
  const mailState = parseMailState(run.mailState);
  const mails = reply?.mails.map((m, i) => (
    <MailCard
      key={`m${i}`}
      botId={bot.id}
      runId={run.id}
      index={i}
      draft={m}
      state={mailState[i]}
      sendRun={(() => {
        const s = mailState[i];
        return s?.status === "sent" ? runsById.get(s.runId) : undefined;
      })()}
      onChange={onChange}
    />
  ));
  const hidden = hidePrompt || quiet;
  return (
    <>
      {incoming ? (
        // A teammate pinged this bot: their face, name and time, then
        // "@ThisBot message" — like a mention in a team chat.
        <BotPost
          author={sender}
          authorName={incoming.fromName}
          time={run.createdAt}
          mention={bot.name}
          message={incoming.message}
          onOpenBot={onOpenBot}
        />
      ) : answerBack ? (
        <p className="flex items-center justify-center gap-1.5 py-1 text-[11.5px] text-muted-foreground">
          ↳ Continuing with {answerBack.teammateName}&apos;s answer
        </p>
      ) : isHandback(run.prompt) ? (
        <p className="flex items-center justify-center gap-1.5 py-1 text-[11.5px] text-muted-foreground">
          <Hand className="h-3 w-3" />
          You gave {bot.name} its computer back
        </p>
      ) : sending ? (
        <p className="flex items-center justify-center gap-1.5 py-1 text-[11.5px] text-muted-foreground">
          <Mail className="h-3 w-3" />
          {sending.mode === "send" ? "You sent" : "You saved as a draft"} “{sending.mail.subject || sending.mail.to}”
        </p>
      ) : restarted ? (
        <p className="flex items-center justify-center gap-1.5 py-1 text-[11.5px] text-muted-foreground">
          <RotateCcw className="h-3 w-3" />
          {bot.name} restarted its computer
          {restarted.reason ? ` ${restarted.reason}` : ""}
        </p>
      ) : routine ? (
        <p className="flex items-center justify-center gap-1.5 py-1 text-[11.5px] text-muted-foreground">
          Routine
          <Clock className="h-3 w-3" />
          {routine.name}
        </p>
      ) : hidden ? null : (
        <div className="flex flex-col items-end gap-1">
          {usedSkill && (
            <span className="flex items-center gap-1 text-[11.5px] text-muted-foreground">
              <Wand2 className="h-3 w-3" />
              Using <span className="font-mono">{usedSkill}</span>
            </span>
          )}
          {attached.length > 0 && <SentAttachments files={attached} />}
          {/* Your messages wear the bot's color. */}
          {ownText && (
          <ContextMenu>
            <ContextMenuTrigger
              render={
                <div
                  className="w-fit max-w-[560px] rounded-2xl px-3.5 py-2.5 text-[13.5px] leading-relaxed whitespace-pre-wrap"
                  style={{ background: bot.color, color: textOn(bot.color) }}
                />
              }
            >
              {ownText}
            </ContextMenuTrigger>
            <ContextMenuContent>
              <ContextMenuItem onClick={() => copyToClipboard(ownText)}>
                <Copy />
                Copy text
              </ContextMenuItem>
              <ContextMenuItem onClick={() => onRetry(run.prompt)}>
                <RotateCcw />
                Send again
              </ContextMenuItem>
              {(run.status === "queued" || run.status === "running") && (
                <>
                  <ContextMenuSeparator />
                  <ContextMenuItem variant="destructive" onClick={() => onCancel(run.id)}>
                    <Square className="fill-current" />
                    Stop this run
                  </ContextMenuItem>
                </>
              )}
            </ContextMenuContent>
          </ContextMenu>
          )}
          {run.status === "queued" && (
            <span className="text-[11px] text-muted-foreground">
              Queued ·{" "}
              <button
                type="button"
                className="hover:text-destructive"
                onClick={() => onCancel(run.id)}
              >
                Cancel
              </button>
            </span>
          )}
        </div>
      )}

      {run.status === "queued" && (quiet || incoming) && (
        <RunIndicator color={bot.color} label="Waking up" />
      )}

      {/* While it works: dots and one line that updates in place, then the
          reply itself as it is written. Stop lives on the composer. */}
      {run.status === "running" && (
        <LiveReply
          botId={bot.id}
          runId={run.id}
          bot={bot}
          bubble={(content) => <Bubble copyable={false}>{content}</Bubble>}
          label={
            isIntro(run.prompt) ? (
              "Typing…"
            ) : run.steps.length ? (
              <CurrentStep key={run.steps.length} step={run.steps.at(-1)!} />
            ) : (
              "Thinking it through"
            )
          }
        />
      )}

      {run.status === "canceled" && (
        <p className="px-1 text-[12px] text-muted-foreground italic">
          Stopped.
        </p>
      )}

      {run.status === "error" &&
        (isMissingClaudeToken(run.error) ? (
          // The first thing a fresh Nexus hits: set it up right here, then
          // the message goes out again. Older ones just say what happened.
          canChoose ? (
            <ClaudeSetupCard color={bot.color} disabled={false} onSaved={() => onRetry(run.prompt)} />
          ) : (
            <p className="px-1 text-[12px] text-muted-foreground">Not sent — Claude Code wasn&apos;t connected yet.</p>
          )
        ) : (
          <Bubble className="text-destructive">
            {run.error ?? "Something went wrong."}
          </Bubble>
        ))}

      {run.status === "completed" &&
        (source ? (
          <>
            {source.body && (
              <Bubble>
                <MarkdownReport variant="chat">{source.body}</MarkdownReport>
              </Bubble>
            )}
            <ProjectSourceCard question={source.question} disabled={!canChoose} onAnswer={onChoose} />
          </>
        ) : credentialCard ? (
          <>
            {credentialCard.body && (
              <Bubble>
                <MarkdownReport variant="chat">{credentialCard.body}</MarkdownReport>
              </Bubble>
            )}
            <CredentialCard
              provider={credentialCard.provider}
              disabled={!canChoose}
              onSaved={onChoose}
              projectId={bot.projectId}
              onOpenVault={onOpenSettings}
              botName={bot.kind === "nexus" ? "Nexus" : bot.name}
              bot={bot}
            />
          </>
        ) : confirmCard ? (
          <>
            {confirmCard.body && (
              <Bubble>
                <MarkdownReport variant="chat">{confirmCard.body}</MarkdownReport>
              </Bubble>
            )}
            <ConfirmCard
              botId={bot.id}
              actionId={confirmCard.actionId}
              title={confirmCard.title}
              detail={confirmCard.detail}
              disabled={!canChoose}
            />
          </>
        ) : runCard ? (
          <>
            {runCard.body && (
              <Bubble>
                <MarkdownReport variant="chat">{runCard.body}</MarkdownReport>
              </Bubble>
            )}
            <RunCard commands={runCard.commands} color={bot.color} onRun={(c) => onRun?.(c)} />
          </>
        ) : choices ? (
          <>
            {choices.body && (
              <Bubble>
                <MarkdownReport variant="chat">{choices.body}</MarkdownReport>
              </Bubble>
            )}
            {posts}
            {mails}
            <ChoicesCard
              choices={choices}
              bot={bot}
              answer={answer}
              disabled={!canChoose}
              onChoose={onChoose}
            />
          </>
        ) : run.needsInput && run.result?.includes(NEEDS_INPUT_MARKER) ? (
          <>
            <Bubble className="space-y-2.5" copyText={reply?.body}>
              <div className="font-medium text-foreground/85 [&_p]:text-foreground/85">
                {reply?.body ? (
                  <MarkdownReport variant="chat">{reply.body}</MarkdownReport>
                ) : (
                  "I need your input."
                )}
              </div>
              {bot.kind !== "nexus" && (
              <button
                type="button"
                onClick={() => onOpenComputer(true)}
                className="inline-flex h-9 items-center gap-2 rounded-full border border-border bg-background/60 py-1 pr-4 pl-1.5 text-[13px] font-medium text-foreground shadow-sm transition-colors hover:border-foreground/25 hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none active:scale-[0.98]"
              >
                <span
                  className="flex h-6 w-6 items-center justify-center rounded-full"
                  style={{ background: bot.color }}
                >
                  <Hand className="h-3.5 w-3.5 text-white" />
                </span>
                Take control of the computer
              </button>
              )}
            </Bubble>
            {posts}
            {mails}
          </>
        ) : (
          <>
            {(reply?.body ||
              (!reply?.routines.length &&
                !reply?.handoffs.length &&
                !reply?.mails.length)) && (
              <Bubble>
                {reply?.body ? (
                  <MarkdownReport variant="chat">{reply.body}</MarkdownReport>
                ) : (
                  "Done."
                )}
              </Bubble>
            )}
            {posts}
            {mails}
          </>
        ))}

      {reply?.routines.map((r, i) => (
        <p
          key={i}
          className="flex items-center justify-center gap-1.5 py-1 text-[11.5px] text-muted-foreground"
        >
          {r.delete ? "Removed routine" : "Updated routine"}
          <Clock className="h-3 w-3" />
          {r.name}
        </p>
      ))}
    </>
  );
});

// ---- Attachments ------------------------------------------------------------

type PendingFile = {
  key: string;
  botId: string;
  name: string;
  size: number;
  /** A local preview while it uploads (images only). */
  preview: string | null;
  status: "uploading" | "ready" | "error";
  url?: string;
  error?: string;
};

const FILES_KEY = "nexux:bot-draft-files:";

type StoredFile = { key: string; name: string; size: number; url: string; image: boolean };

// Outside React, like the draft text: the chat unmounts when you open another
// bot or leave the page, and an upload still in flight has to land somewhere.
let pendingFiles: PendingFile[] = [];
const pendingListeners = new Set<() => void>();
const pendingLoaded = new Set<string>();
const NO_FILES: PendingFile[] = [];

function subscribePending(listener: () => void) {
  pendingListeners.add(listener);
  return () => {
    pendingListeners.delete(listener);
  };
}

function setPending(botId: string, update: (xs: PendingFile[]) => PendingFile[]) {
  pendingFiles = update(pendingFiles);
  // Only what finished uploading is worth keeping: it is the URL that survives.
  const ready: StoredFile[] = pendingFiles.flatMap((f) =>
    f.botId === botId && f.status === "ready" && f.url
      ? [{ key: f.key, name: f.name, size: f.size, url: f.url, image: f.preview !== null }]
      : [],
  );
  try {
    if (ready.length) window.localStorage.setItem(FILES_KEY + botId, JSON.stringify(ready));
    else window.localStorage.removeItem(FILES_KEY + botId);
  } catch {
    // Storage unavailable: the files just live for this visit.
  }
  for (const l of pendingListeners) l();
}

function loadPending(botId: string) {
  if (pendingLoaded.has(botId)) return;
  pendingLoaded.add(botId);
  let stored: StoredFile[];
  try {
    stored = JSON.parse(window.localStorage.getItem(FILES_KEY + botId) ?? "[]") as StoredFile[];
  } catch {
    return;
  }
  if (!Array.isArray(stored) || stored.length === 0) return;
  pendingFiles = [
    ...pendingFiles,
    ...stored.map(
      (f): PendingFile => ({
        key: f.key,
        botId,
        name: f.name,
        size: f.size,
        // The local blob is gone after a reload; the uploaded file is its own preview.
        preview: f.image ? f.url : null,
        status: "ready",
        url: f.url,
      }),
    ),
  ];
  for (const l of pendingListeners) l();
}

/**
 * Files picked, pasted or dropped for the next message, uploading as they come.
 * They stay with the bot's draft until sent or removed, across bots and reloads.
 */
function usePendingFiles(botId: string) {
  const all = useSyncExternalStore(subscribePending, () => pendingFiles, () => NO_FILES);
  useEffect(() => loadPending(botId), [botId]);
  const items = all.filter((f) => f.botId === botId);
  const patch = (key: string, p: Partial<PendingFile>) =>
    setPending(botId, (xs) => xs.map((x) => (x.key === key ? { ...x, ...p } : x)));
  const drop = (keep: (f: PendingFile) => boolean) =>
    setPending(botId, (xs) => {
      for (const x of xs) if (!keep(x) && x.preview?.startsWith("blob:")) URL.revokeObjectURL(x.preview);
      return xs.filter(keep);
    });

  return {
    items,
    ready: items.flatMap((f) => (f.status === "ready" && f.url ? [{ name: f.name, url: f.url }] : [])),
    uploading: items.some((f) => f.status === "uploading"),
    /** Returns why some files were not added, or null. */
    add(list: Iterable<File>): string | null {
      const files = [...list];
      const room = MAX_ATTACHMENTS - items.length;
      const tooBig = files.filter((f) => f.size > MAX_ATTACHMENT_BYTES);
      const ok = files.filter((f) => f.size <= MAX_ATTACHMENT_BYTES && f.size > 0).slice(0, Math.max(room, 0));
      for (const file of ok) {
        const key = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
        const preview = file.type.startsWith("image/") ? URL.createObjectURL(file) : null;
        setPending(botId, (xs) => [...xs, { key, botId, name: file.name, size: file.size, preview, status: "uploading" }]);
        uploadBotFile(botId, file).then(
          (r) => patch(key, { status: "ready", url: r.url, name: r.name }),
          (err) => patch(key, { status: "error", error: err instanceof Error ? err.message : "Upload failed" }),
        );
      }
      if (tooBig.length) return `${tooBig.map((f) => f.name).join(", ")}: files can be up to 25 MB`;
      if (files.length > ok.length) return `Up to ${MAX_ATTACHMENTS} files per message`;
      return null;
    },
    remove: (key: string) => drop((x) => x.key !== key),
    clear: () => drop((x) => x.botId !== botId),
  };
}

/** Files in a paste: a screenshot, an image copied from a page, files copied in Finder. */
function filesFromClipboard(data: DataTransfer): File[] {
  const files = data.files.length
    ? [...data.files]
    : [...data.items].flatMap((it) => (it.kind === "file" ? [it.getAsFile()].filter((f): f is File => f !== null) : []));
  return files.map((f) => {
    // Screenshots arrive as "image.png": give them a name that tells them apart.
    if (!/^image\.\w+$/i.test(f.name) && f.name) return f;
    const ext = (f.type.split("/")[1] ?? "png").replace("jpeg", "jpg").replace(/[^a-z0-9]/g, "");
    return new File([f], `pasted-${format(new Date(), "HHmmss")}.${ext}`, { type: f.type });
  });
}

function fileSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function PendingFileChip({ file, onRemove }: { file: PendingFile; onRemove: () => void }) {
  const failed = file.status === "error";
  return (
    <div
      className={cn(
        "group/file relative flex items-center gap-2 rounded-xl border bg-background/60",
        file.preview ? "p-0" : "py-1.5 pr-7 pl-2",
        failed ? "border-destructive/60" : "border-border",
      )}
      title={failed ? file.error : file.name}
    >
      {file.preview ? (
        // eslint-disable-next-line @next/next/no-img-element -- a local blob preview
        <img src={file.preview} alt={file.name} className="h-16 w-16 rounded-xl object-cover" />
      ) : (
        <>
          <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span className="min-w-0">
            <span className="block max-w-[180px] truncate text-[12.5px]">{file.name}</span>
            <span className={cn("block text-[11px]", failed ? "text-destructive" : "text-muted-foreground")}>
              {failed ? "Not uploaded" : fileSize(file.size)}
            </span>
          </span>
        </>
      )}
      {file.status === "uploading" && (
        <span className="absolute inset-0 flex items-center justify-center rounded-xl bg-background/50">
          <Loader2 className="h-4 w-4 animate-spin" />
        </span>
      )}
      {failed && file.preview && (
        <span className="absolute inset-x-0 bottom-0 rounded-b-xl bg-destructive/90 text-center text-[10px] text-white">
          Failed
        </span>
      )}
      <button
        type="button"
        onClick={onRemove}
        aria-label={`Remove ${file.name}`}
        className="absolute -top-1.5 -right-1.5 flex h-5 w-5 items-center justify-center rounded-full border border-border bg-card text-muted-foreground shadow-sm hover:text-foreground"
      >
        <X className="h-3 w-3" />
      </button>
    </div>
  );
}

/** What you attached to a message, above its bubble: images to open, files to download. */
function SentAttachments({ files }: { files: Attachment[] }) {
  const [open, setOpen] = useState<number | null>(null);
  const images = files.filter((f) => f.image).map((f) => ({ src: f.url, alt: f.name }));
  const others = files.filter((f) => !f.image);
  return (
    <>
      {images.length > 0 && (
        <div className="flex max-w-[560px] flex-wrap justify-end gap-1.5">
          {images.map((im, i) => (
            <button
              key={im.src}
              type="button"
              onClick={() => setOpen(i)}
              className="cursor-zoom-in"
              title={im.alt}
            >
              {/* eslint-disable-next-line @next/next/no-img-element -- served by Nexus, arbitrary size */}
              <img
                src={im.src}
                alt={im.alt}
                loading="lazy"
                className={cn(
                  "rounded-2xl border border-border/50 object-cover",
                  images.length === 1 ? "max-h-64 max-w-[320px]" : "h-28 w-28",
                )}
              />
            </button>
          ))}
        </div>
      )}
      {others.map((f) => (
        <button
          key={f.url}
          type="button"
          onClick={() => void openExternal(new URL(f.url, window.location.origin).toString())}
          className="flex max-w-[320px] items-center gap-2 rounded-2xl border border-border bg-card/70 px-3 py-2 text-left hover:bg-card"
          title="Open"
        >
          <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span className="truncate text-[12.5px]">{f.name}</span>
        </button>
      ))}
      <ImageLightbox images={images} index={open} onIndex={setOpen} onClose={() => setOpen(null)} />
    </>
  );
}
