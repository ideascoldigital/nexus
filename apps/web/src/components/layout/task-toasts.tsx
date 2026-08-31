"use client";

// Floating popups, top-right: a run just finished, or just stopped to ask.
//
// Its own stack rather than the shared `useToast`, whose viewport sits
// bottom-right and belongs to the whole app — moving it would relocate every
// other toast. This one also needs things a toast does not have: a chime, a
// click that navigates to the run, and a mute.

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { CircleAlert, CircleCheck, CircleX, Volume2, VolumeX, X } from "lucide-react";

import { isMuted, playChime, setMuted } from "@/lib/notify-sound";
import {
  activityHref,
  getActivity,
  newlyFinished,
  type ActivityEntry,
} from "@/services/activity";

/** How long a popup stays before fading itself out. */
const DISMISS_MS = 5_000;

export function TaskToasts() {
  const router = useRouter();
  const [shown, setShown] = useState<ActivityEntry[]>([]);
  const [muted, setMutedState] = useState(false);

  // Everything already popped up, plus — on the very first response — whatever
  // had finished before this page existed. Without that seeding a fresh load
  // would chime once per historical run.
  const announced = useRef<Set<string> | null>(null);

  useEffect(() => {
    setMutedState(isMuted());
  }, []);

  const activity = useQuery({
    queryKey: ["activity"],
    queryFn: getActivity,
    // Tighter than the bell's poll: this one is meant to arrive while you are
    // still looking at something else.
    refetchInterval: 10_000,
  });

  const data = activity.data;
  useEffect(() => {
    if (!data) return;

    const blocked = data.active.filter((t) => t.needsInput);
    const candidates = [...data.recent, ...blocked];

    if (announced.current === null) {
      // First response: adopt the world as already-announced and stay quiet.
      announced.current = new Set(candidates.map((t) => t.id));
      return;
    }

    const fresh = [
      ...newlyFinished(data.recent, announced.current),
      ...blocked.filter((t) => !announced.current!.has(t.id)),
    ];
    if (fresh.length === 0) return;

    for (const t of fresh) announced.current.add(t.id);
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setShown((prev) => [...fresh, ...prev].slice(0, 4));
    playChime(fresh.some((t) => t.status === "error") ? "error" : "done");
  }, [data]);

  const dismiss = (id: string) =>
    setShown((prev) => prev.filter((t) => t.id !== id));

  if (shown.length === 0) return null;

  return (
    <div className="pointer-events-none fixed right-4 top-4 z-[120] flex w-80 flex-col gap-2">
      {shown.map((t) => (
        <Popup
          key={t.id}
          entry={t}
          muted={muted}
          onToggleMute={() => {
            const next = !muted;
            setMutedState(next);
            setMuted(next);
          }}
          onOpen={() => {
            router.push(activityHref(t));
            dismiss(t.id);
          }}
          onDismiss={() => dismiss(t.id)}
        />
      ))}
    </div>
  );
}

function Popup({
  entry,
  muted,
  onOpen,
  onDismiss,
  onToggleMute,
}: {
  entry: ActivityEntry;
  muted: boolean;
  onOpen: () => void;
  onDismiss: () => void;
  onToggleMute: () => void;
}) {
  // The parent re-renders on every 10s activity poll and hands down a fresh
  // onDismiss closure each time. With onDismiss in the effect deps, that
  // re-armed the timer before it could ever fire — popups never left. The
  // ref keeps the timer's schedule tied to the popup, not to render churn.
  const dismissRef = useRef(onDismiss);
  dismissRef.current = onDismiss;
  useEffect(() => {
    // A run blocked on a question stays until acknowledged — it is a request,
    // not an announcement, and timing it out would lose the only one that
    // actually needs an answer.
    if (entry.needsInput) return;
    const timer = setTimeout(() => dismissRef.current(), DISMISS_MS);
    return () => clearTimeout(timer);
  }, [entry.needsInput, entry.id]);

  const Icon = entry.needsInput
    ? CircleAlert
    : entry.status === "error"
      ? CircleX
      : CircleCheck;
  const tone = entry.needsInput
    ? "text-amber-400"
    : entry.status === "error"
      ? "text-destructive"
      : "text-emerald-400";
  const heading = entry.needsInput
    ? "Waiting on you"
    : entry.status === "error"
      ? "Failed"
      : "Finished";

  return (
    <div className="pointer-events-auto animate-in slide-in-from-right-4 fade-in rounded-lg border border-border/70 bg-popover p-3 shadow-lg ring-1 ring-foreground/10">
      <div className="flex items-start gap-2">
        <Icon className={`mt-0.5 h-4 w-4 shrink-0 ${tone}`} />
        <button
          type="button"
          onClick={onOpen}
          className="min-w-0 flex-1 text-left"
          title="Open"
        >
          <span className="block text-xs font-semibold">{heading}</span>
          <span className="mt-0.5 block truncate text-[11px]">
            {entry.title}
          </span>
          <span className="mt-0.5 block truncate text-[10px] text-muted-foreground">
            {entry.projectName} · {entry.sandboxName}
          </span>
        </button>
        <div className="flex shrink-0 flex-col gap-1">
          <button
            type="button"
            onClick={onDismiss}
            className="text-muted-foreground hover:text-foreground"
            aria-label="Dismiss"
          >
            <X className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={onToggleMute}
            className="text-muted-foreground hover:text-foreground"
            aria-label={muted ? "Unmute" : "Mute"}
            title={muted ? "Unmute" : "Mute notifications"}
          >
            {muted ? (
              <VolumeX className="h-3.5 w-3.5" />
            ) : (
              <Volume2 className="h-3.5 w-3.5" />
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
