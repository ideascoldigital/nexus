"use client";

// Header counters: machines up, runs executing, runs stalled. Clicking opens
// the ⌘J switcher, which is the same data with names attached.

import { useQuery } from "@tanstack/react-query";
import { CirclePause, Play, Server } from "lucide-react";

import { useHydrated } from "@/hooks/use-hydrated";
import { activityCounts, getActivity } from "@/services/activity";

/**
 * Asks the shell to open the switcher.
 *
 * A custom event rather than lifted state: the switcher belongs to AppShell and
 * the header is a sibling three components away, so threading a setter through
 * would put an `onOpenActivity` prop on everything in between that has no
 * interest in it.
 */
export const OPEN_ACTIVITY_EVENT = "nexux:open-activity";

export function ActivityIndicator() {
  const activity = useQuery({
    queryKey: ["activity"],
    queryFn: getActivity,
    refetchInterval: 10_000,
  });
  // The header hydrates inside the page's Suspense boundary, often after the
  // shell's ⌘J switcher has already filled the shared ["activity"] cache — so
  // the first client render had counts the server (no data) never rendered,
  // and React threw a hydration mismatch. Render the server's nothing first.
  const hydrated = useHydrated();
  const counts = activityCounts(hydrated ? activity.data : undefined);

  // Nothing up and nothing running: an all-zero row is noise on a fresh
  // install, so it stays out of the way until there is something to say.
  if (counts.sandboxes === 0 && counts.running === 0 && counts.waiting === 0) {
    return null;
  }

  return (
    <button
      type="button"
      onClick={() => window.dispatchEvent(new CustomEvent(OPEN_ACTIVITY_EVENT))}
      className="flex items-center gap-2.5 rounded-lg border border-border/70 px-2.5 py-1.5 font-mono text-[11px] text-muted-foreground transition-colors hover:border-primary/40 hover:text-accent-foreground"
      title={[
        `${counts.sandboxes} sandbox${counts.sandboxes === 1 ? "" : "es"} running`,
        `${counts.running} process${counts.running === 1 ? "" : "es"} executing`,
        counts.waiting > 0
          ? `${counts.waiting} waiting (${counts.blocked} waiting on your reply, ${counts.waiting - counts.blocked} queued)`
          : "nothing waiting",
        "",
        "Click or ⌘J to view them",
      ].join("\n")}
    >
      <Count icon={<Server className="h-3 w-3" />} value={counts.sandboxes} />
      <Count icon={<Play className="h-3 w-3" />} value={counts.running} />
      <Count
        icon={<CirclePause className="h-3 w-3" />}
        value={counts.waiting}
        // Only the blocked half is worth an alarm colour: a queued run is
        // waiting on the machine, not on you.
        tone={counts.blocked > 0 ? "text-amber-400" : undefined}
      />
    </button>
  );
}

function Count({
  icon,
  value,
  tone,
}: {
  icon: React.ReactNode;
  value: number;
  tone?: string;
}) {
  return (
    <span className={`flex items-center gap-1 ${tone ?? ""}`}>
      {icon}
      {value}
    </span>
  );
}
