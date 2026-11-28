"use client";

// A bot at work in the chat (spec 39). Before anything is written: three dots
// in the bot's colour and a shimmering line — "Thinking it through", or the
// step it is on. Once the reply starts: the reply itself, growing as it is
// written, with "Typing…" under it. No buttons here — Stop is the composer's
// send button while a run is going.

import { useEffect, useRef, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { BotAvatar } from "@/components/bots/bot-avatar";
import { MarkdownReport } from "@/components/ui/markdown-report";
import { draftBody } from "@/lib/run-draft-view";

export function WorkingDots({ color }: { color: string }) {
  return (
    <span className="flex animate-in items-center gap-[3px] duration-300 zoom-in-50 fade-in" aria-hidden>
      {[0, 160, 320].map((d) => (
        <span key={d} className="nexux-dot h-[7px] w-[7px] rounded-full" style={{ background: color, animationDelay: `${d}ms` }} />
      ))}
    </span>
  );
}

/** Dots and a line: nothing written yet. */
export function RunIndicator({ color, label }: { color: string; label: ReactNode }) {
  return (
    <div className="flex min-h-7 items-center gap-2.5 px-1 py-1" role="status" aria-live="polite">
      <WorkingDots color={color} />
      <span className="min-w-0 truncate text-[12.5px]">
        {typeof label === "string" ? <span className="nexux-shimmer">{label}</span> : label}
      </span>
    </div>
  );
}

/**
 * The reply a running run is writing, polled from the server's memory and
 * revealed a few characters a frame so it reads as typing, not as jumps.
 * Falls back to the indicator until the first words arrive.
 */
export function LiveReply({
  botId,
  runId,
  bot,
  label,
  bubble,
}: {
  botId: string;
  runId: string;
  bot: { shape: string; color: string };
  label: ReactNode;
  /** The chat's own reply bubble around the text. */
  bubble: (content: ReactNode) => ReactNode;
}) {
  const { data } = useQuery({
    queryKey: ["run-draft", runId],
    queryFn: async () => {
      const res = await fetch(`/api/bots/${botId}/runs/${runId}`);
      if (!res.ok) return null;
      return ((await res.json()) as { draft: string | null }).draft;
    },
    refetchInterval: 400,
  });
  const qc = useQueryClient();
  // Sticky: once words are on screen they stay until newer ones replace them.
  // The draft goes empty in two moments that are not "nothing written": a new
  // message starting after a tool call, and the run finishing (the server
  // drops the draft once the reply is saved). Dropping the text there made it
  // vanish, then come back whole with its card.
  const fresh = draftBody(data);
  const [kept, setKept] = useState("");
  if (fresh && fresh !== kept) setKept(fresh);
  const target = fresh || kept;
  const shown = useTypewriter(target);
  // Gone after there was text: most likely finished — fetch the saved reply
  // now instead of waiting for the chat's next poll.
  const hadText = Boolean(kept);
  useEffect(() => {
    if (hadText && data === null) void qc.invalidateQueries({ queryKey: ["bot-feed", botId] });
  }, [hadText, data, qc, botId]);

  if (!shown) return <RunIndicator color={bot.color} label={label} />;
  return (
    <div className="space-y-1.5">
      {bubble(
        <MarkdownReport variant="chat" className="nexux-caret">
          {shown}
        </MarkdownReport>,
      )}
      <div className="flex items-center gap-2 px-1 text-[11.5px] text-muted-foreground">
        <BotAvatar shape={bot.shape} color={bot.color} size={16} />
        <span className="nexux-shimmer">Typing…</span>
      </div>
    </div>
  );
}

/** `target`, caught up with a little each frame — faster the further behind. */
function useTypewriter(target: string): string {
  const [shown, setShown] = useState(target);
  const shownRef = useRef(target);
  useEffect(() => {
    // A new message started over (or the text was rewritten): jump.
    if (!target.startsWith(shownRef.current.slice(0, Math.min(shownRef.current.length, target.length)))) {
      shownRef.current = target;
      setShown(target);
      return;
    }
    let frame = 0;
    const step = () => {
      const cur = shownRef.current;
      if (cur.length >= target.length) {
        if (cur !== target) {
          shownRef.current = target;
          setShown(target);
        }
        return;
      }
      const behind = target.length - cur.length;
      const next = target.slice(0, cur.length + Math.max(2, Math.ceil(behind / 12)));
      shownRef.current = next;
      setShown(next);
      frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [target]);
  return shown;
}
