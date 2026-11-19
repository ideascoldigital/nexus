"use client";

// The conversation with one bot: grey bubbles for the bot, your messages on
// the right, centred timestamps, chips for what it did on its computer, a
// "NEW" line at the first message you had not seen, and a pill composer.

import {
  Fragment,
  memo,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useMutation } from "@tanstack/react-query";
import { format, isToday, isYesterday } from "date-fns";
import {
  ArrowUp,
  Clock,
  FileText,
  Globe,
  Hand,
  Loader2,
  MonitorPlay,
  PanelRight,
  Search,
  Square,
  SquareTerminal,
  Wrench,
} from "lucide-react";

import { BotAvatar } from "@/components/bots/bot-avatar";
import { Button } from "@/components/ui/button";
import { MarkdownReport } from "@/components/ui/markdown-report";
import { useToast } from "@/hooks/use-toast";
import { CHOICE_LETTERS, type BotChoices } from "@/lib/bot-choices";
import { findTeammate, handoffRun, replyRun } from "@/lib/bot-handoffs";
import { isHandback, isIntro } from "@/lib/bot-prompts";
import { textOn } from "@/lib/bot-shapes";
import { routineRun, splitReply } from "@/lib/bot-routines";

// Mirrors agent-core's marker; that module is server-side.
const NEEDS_INPUT_MARKER = "NEEDS_INPUT:";
import { cn } from "@/lib/utils";
import {
  cancelBotRun,
  sendBotPrompt,
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
  onOpenComputer,
  onChange,
  team,
  onOpenBot,
}: {
  bot: BotListItem;
  feed: BotFeed | undefined;
  team: BotListItem[];
  onOpenBot: (id: string) => void;
  /** The first run that landed since you last looked — gets the NEW line. */
  firstUnreadId: string | null;
  panelOpen: boolean;
  onTogglePanel: () => void;
  onOpenComputer: () => void;
  onChange: () => void;
}) {
  const { toast } = useToast();
  const [prompt, setPrompt] = useState("");
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

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

  const runs = feed?.runs ?? [];
  // Teammates' replies to this bot's handoffs, grouped under the run that sent them.
  const threadsByRun = new Map<string, BotThreadReply[]>();
  for (const t of feed?.threads ?? []) {
    threadsByRun.set(t.sourceRunId, [
      ...(threadsByRun.get(t.sourceRunId) ?? []),
      t,
    ]);
  }
  const busy = runs.some(
    (r) => r.status === "queued" || r.status === "running",
  );
  const last = runs.at(-1);

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

  const submit = () => {
    const text = prompt.trim();
    if (text && !send.isPending) send.mutate(text);
  };

  return (
    <section className="relative flex min-h-0 min-w-0 flex-1 flex-col">
      {/* Floating title */}
      <div className="pointer-events-none absolute inset-x-0 top-0 z-10 flex items-center justify-center bg-gradient-to-b from-background via-background/80 to-transparent px-4 pt-3 pb-6">
        {/* The top strip drags the window in the macOS app (overlay title bar). */}
        <div
          data-tauri-drag-region
          className="titlebar-only pointer-events-auto absolute inset-x-0 top-0 h-12"
        />
        <button
          type="button"
          onClick={onTogglePanel}
          className="group pointer-events-auto flex items-center gap-2 rounded-full border border-border bg-card/90 py-1 pr-3.5 pl-1.5 text-[13.5px] shadow-sm backdrop-blur transition-colors hover:bg-card"
        >
          <BotAvatar shape={bot.shape} color={bot.color} size={24} />
          {bot.name}
        </button>
        {!panelOpen && (
          <Button
            variant="secondary"
            size="sm"
            className="pointer-events-auto absolute top-3 right-4 rounded-full px-3"
            onClick={onTogglePanel}
          >
            <PanelRight className="h-3.5 w-3.5" />
            Details
          </Button>
        )}
      </div>

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
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
                {newSession && (
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
                  onOpenComputer={onOpenComputer}
                  onChoose={(option) => send.mutate(option)}
                  onSomethingElse={() => inputRef.current?.focus()}
                  team={team}
                  onOpenBot={onOpenBot}
                  threads={threadsByRun.get(r.id)}
                />
              </Fragment>
            );
          })}
        </div>
      </div>

      <div className="shrink-0 px-6 pb-5">
        <div className="mx-auto flex w-full max-w-[960px] items-end gap-2 rounded-[22px] border border-border bg-card/70 py-1.5 pr-1.5 pl-4 focus-within:border-foreground/25">
          <textarea
            ref={inputRef}
            rows={1}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
            placeholder={
              busy
                ? `${bot.name} is busy. This will run next…`
                : `Message ${bot.name}`
            }
            className="max-h-40 min-h-[30px] flex-1 resize-none bg-transparent py-1.5 text-[13.5px] leading-5 outline-none placeholder:text-muted-foreground"
          />
          <button
            type="button"
            onClick={submit}
            disabled={!prompt.trim() || send.isPending}
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
        </div>
      </div>
    </section>
  );
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

function Bubble({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "w-fit max-w-[560px] rounded-2xl bg-card px-3.5 py-2.5 text-[13.5px] leading-relaxed",
        className,
      )}
    >
      {children}
    </div>
  );
}

function TypingBubble({
  label,
  children,
}: {
  label: ReactNode;
  children?: ReactNode;
}) {
  return (
    <Bubble className="flex items-center gap-3 bg-card/60">
      <span className="flex gap-1" aria-hidden>
        {[0, 150, 300].map((d) => (
          <span
            key={d}
            className="h-1.5 w-1.5 animate-bounce rounded-full bg-muted-foreground"
            style={{ animationDelay: `${d}ms` }}
          />
        ))}
      </span>
      <span className="min-w-0 flex-1 text-[12.5px] text-muted-foreground">
        {label}
      </span>
      {children}
    </Bubble>
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
                <MarkdownReport>{r.text ?? "Done."}</MarkdownReport>
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
  onSomethingElse,
}: {
  choices: BotChoices;
  bot: BotListItem;
  answer: string | null;
  disabled: boolean;
  onChoose: (option: string) => void;
  onSomethingElse: () => void;
}) {
  const letter = (i: number) => CHOICE_LETTERS[i] ?? "•";
  const picked = answer ? choices.options.indexOf(answer) : -1;
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
          <button
            type="button"
            disabled={disabled}
            onClick={onSomethingElse}
            className="group flex w-full items-center gap-3 rounded-lg px-1 py-1.5 text-left text-[13.5px] text-muted-foreground transition-colors hover:bg-accent/60 disabled:opacity-50"
          >
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md border border-border text-[11px]">
              {letter(choices.options.length)}
            </span>
            Something else
          </button>
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
  onOpenComputer,
  onChoose,
  onSomethingElse,
  team,
  onOpenBot,
  threads,
}: {
  run: BotRun;
  bot: BotListItem;
  team: BotListItem[];
  onOpenBot: (id: string) => void;
  threads?: BotThreadReply[];
  /** Its prompt is shown elsewhere (the option picked in the card above). */
  hidePrompt: boolean;
  /** The option the user picked from this run's question, if any. */
  answer: string | null;
  canChoose: boolean;
  onCancel: (runId: string) => void;
  onOpenComputer: () => void;
  onChoose: (option: string) => void;
  onSomethingElse: () => void;
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
  const routine = routineRun(run.prompt);
  const incoming = handoffRun(run.prompt);
  const sender = incoming
    ? (team.find((b) => b.id === incoming.fromId) ?? null)
    : null;
  const answerBack = replyRun(run.prompt);
  // The app sent it, not you (an intro, a routine, a teammate's answer coming back).
  const quiet = isIntro(run.prompt) || routine !== null || answerBack !== null;
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
      ) : routine ? (
        <p className="flex items-center justify-center gap-1.5 py-1 text-[11.5px] text-muted-foreground">
          Routine
          <Clock className="h-3 w-3" />
          {routine.name}
        </p>
      ) : hidden ? null : (
        <div className="flex flex-col items-end gap-1">
          {/* Your messages wear the bot's color. */}
          <div
            className="w-fit max-w-[560px] rounded-2xl px-3.5 py-2.5 text-[13.5px] leading-relaxed whitespace-pre-wrap"
            style={{ background: bot.color, color: textOn(bot.color) }}
          >
            {run.prompt}
          </div>
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
        <TypingBubble label="Waking up" />
      )}

      {/* Progress is a single line that updates in place, and goes away with
          the reply — the conversation reads like a chat, not a log. */}
      {run.status === "running" && (
        <TypingBubble
          label={
            isIntro(run.prompt) ? (
              "Typing"
            ) : run.steps.length ? (
              <CurrentStep key={run.steps.length} step={run.steps.at(-1)!} />
            ) : (
              "Working"
            )
          }
        >
          {!isIntro(run.prompt) && (
            <>
              <button
                type="button"
                onClick={onOpenComputer}
                className="shrink-0 text-[12px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
              >
                Watch
              </button>
              <button
                type="button"
                onClick={() => onCancel(run.id)}
                className="inline-flex shrink-0 items-center gap-1 text-[12px] text-muted-foreground hover:text-destructive"
              >
                <Square className="h-2.5 w-2.5 fill-current" />
                Stop
              </button>
            </>
          )}
        </TypingBubble>
      )}

      {run.status === "canceled" && (
        <p className="px-1 text-[12px] text-muted-foreground italic">
          Stopped.
        </p>
      )}

      {run.status === "error" && (
        <Bubble className="text-destructive">
          {run.error ?? "Something went wrong."}
        </Bubble>
      )}

      {run.status === "completed" &&
        (choices ? (
          <>
            {choices.body && (
              <Bubble>
                <MarkdownReport>{choices.body}</MarkdownReport>
              </Bubble>
            )}
            {posts}
            <ChoicesCard
              choices={choices}
              bot={bot}
              answer={answer}
              disabled={!canChoose}
              onChoose={onChoose}
              onSomethingElse={onSomethingElse}
            />
          </>
        ) : run.needsInput && run.result?.includes(NEEDS_INPUT_MARKER) ? (
          <>
            <Bubble className="space-y-2.5">
              <div className="font-medium text-foreground/85 [&_p]:text-foreground/85">
                {reply?.body ? (
                  <MarkdownReport>{reply.body}</MarkdownReport>
                ) : (
                  "I need your input."
                )}
              </div>
              <button
                type="button"
                onClick={onOpenComputer}
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
            </Bubble>
            {posts}
          </>
        ) : (
          <>
            {(reply?.body ||
              (!reply?.routines.length && !reply?.handoffs.length)) && (
              <Bubble>
                {reply?.body ? (
                  <MarkdownReport>{reply.body}</MarkdownReport>
                ) : (
                  "Done."
                )}
              </Bubble>
            )}
            {posts}
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
