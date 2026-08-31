"use client";

// Header bell: agent runs that finished, and runs blocked on a question.
//
// Shares its query and its "seen" mark with the ⌘J switcher — one cache, one
// notion of having looked. The bell is the ambient half (it tells you without
// being asked); ⌘J is the deliberate half.

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { formatDistanceToNow } from "date-fns";
import { Bell, CircleAlert, CircleCheck, CircleX } from "lucide-react";

import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  activityHref,
  getActivity,
  lastSeenAt,
  markSeen,
  notifications,
  type ActivityEntry,
} from "@/services/activity";

export function NotificationBell() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  // Captured when the panel opens, before marking: computing "unseen" against a
  // mark this very opening wrote would always come back empty.
  const [seenAt, setSeenAt] = useState<string | null>(null);

  const activity = useQuery({
    queryKey: ["activity"],
    queryFn: getActivity,
    // Polls while mounted, not only while open — a bell that only counts once
    // you click it is not telling you anything.
    refetchInterval: 20_000,
  });

  useEffect(() => {
    if (!open) return;
    setSeenAt(lastSeenAt());
    // Marked on open: a badge clears when you look at it, and the list you are
    // looking at was already captured above.
    markSeen();
  }, [open]);

  // Kept fresh while the panel is shut so the badge tracks reality; frozen at
  // the captured mark while it is open, so items do not vanish under the cursor.
  const [liveSeen, setLiveSeen] = useState<string | null>(null);
  useEffect(() => {
    if (open) return;
    setLiveSeen(lastSeenAt());
  }, [open, activity.dataUpdatedAt]);

  const { blocked, finished, unseenIds, count } = useMemo(
    () => notifications(activity.data, open ? seenAt : liveSeen),
    [activity.data, open, seenAt, liveSeen],
  );

  const go = (entry: ActivityEntry) => {
    router.push(activityHref(entry));
    setOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <button
            type="button"
            className="relative flex h-7 w-7 items-center justify-center rounded-lg border border-border/70 text-muted-foreground transition-colors hover:border-primary/40 hover:text-accent-foreground"
            title={
              count > 0
                ? `${count} notification${count === 1 ? "" : "s"}`
                : "No notifications"
            }
            aria-label={`Notifications${count > 0 ? ` (${count})` : ""}`}
          />
        }
      >
        <Bell className="h-3.5 w-3.5" />
        {count > 0 && (
          <span
            className={`absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[9px] font-semibold text-background ${
              blocked.length > 0 ? "bg-amber-400" : "bg-primary"
            }`}
          >
            {count > 9 ? "9+" : count}
          </span>
        )}
      </PopoverTrigger>

      <PopoverContent align="end" className="w-96 p-0">
        <div className="flex items-center justify-between border-b border-border/60 px-3 py-2">
          <span className="text-xs font-semibold">Notifications</span>
          <kbd className="rounded bg-muted px-1.5 text-[10px] text-muted-foreground">
            ⌘J
          </kbd>
        </div>

        <div className="max-h-96 overflow-y-auto">
          {blocked.length === 0 && finished.length === 0 && (
            <p className="px-3 py-6 text-center text-[11px] text-muted-foreground">
              Nothing finished or waiting.
            </p>
          )}

          {blocked.length > 0 && (
            <Section title="Waiting for your reply">
              {blocked.map((t) => (
                <NotificationRow key={t.id} entry={t} onSelect={go} unread />
              ))}
            </Section>
          )}

          {finished.length > 0 && (
            <Section title="Finished">
              {finished.map((t) => (
                <NotificationRow
                  key={t.id}
                  entry={t}
                  onSelect={go}
                  unread={unseenIds.has(t.id)}
                />
              ))}
            </Section>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="py-1">
      <p className="px-3 py-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
        {title}
      </p>
      {children}
    </div>
  );
}

function NotificationRow({
  entry,
  onSelect,
  unread,
}: {
  entry: ActivityEntry;
  onSelect: (e: ActivityEntry) => void;
  /** New since the panel was last opened — marked, not hidden. */
  unread?: boolean;
}) {
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
  const when = entry.finishedAt ?? entry.updatedAt;

  return (
    <button
      type="button"
      onClick={() => onSelect(entry)}
      className={`flex w-full items-start gap-2 px-3 py-2 text-left transition-colors hover:bg-accent ${
        unread ? "" : "opacity-60"
      }`}
    >
      <Icon className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${tone}`} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-xs">{entry.title}</span>
        <span className="block truncate text-[10px] text-muted-foreground">
          {entry.projectName} · {entry.sandboxName}
          {when
            ? ` · ${formatDistanceToNow(new Date(when), { addSuffix: true })}`
            : ""}
        </span>
      </span>
    </button>
  );
}
