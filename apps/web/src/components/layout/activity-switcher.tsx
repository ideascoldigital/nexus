"use client";

// ⌘J — jump between the agent runs and sandboxes that want you right now.
//
// A keyboard overlay rather than a floating badge: the shell already has a
// ⌘K palette, so the gesture is learned, and nothing has to occupy screen
// space to be one keystroke away.

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { formatDistanceToNow } from "date-fns";
import {
  Bot,
  CircleAlert,
  Loader2,
  MessageSquareCode,
  Server,
} from "lucide-react";

import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command";
import {
  activityHref,
  getActivity,
  lastSeenAt,
  markSeen,
  unseenSince,
  type ActivityEntry,
  type ActivitySandbox,
} from "@/services/activity";

export function ActivitySwitcher({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  // Read once per opening, before marking: computing "unseen" against a mark
  // this very opening just wrote would always come back empty.
  const [seenAt, setSeenAt] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setSeenAt(lastSeenAt());
      return;
    }
    // Marked on close, so a glance at the list is what clears it.
    markSeen();
  }, [open]);

  const activity = useQuery({
    queryKey: ["activity"],
    queryFn: getActivity,
    enabled: open,
    // Open and watching a run: keep it live without polling the rest of the app.
    refetchInterval: open ? 5000 : false,
  });

  const { blocked, running, unseen, idle } = useMemo(() => {
    const active = activity.data?.active ?? [];
    return {
      blocked: active.filter((t) => t.needsInput),
      running: active.filter((t) => !t.needsInput),
      unseen: unseenSince(activity.data?.recent ?? [], seenAt),
      idle: activity.data?.idleSandboxes ?? [],
    };
  }, [activity.data, seenAt]);

  const go = (entry: ActivityEntry | ActivitySandbox) => {
    router.push(activityHref(entry));
    onOpenChange(false);
  };

  const empty =
    !activity.isLoading &&
    blocked.length + running.length + unseen.length + idle.length === 0;

  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Active work"
      description="Agent runs and sandboxes that want your attention"
    >
      {/* CommandDialog renders only the dialog chrome — the cmdk root is the
          consumer's to place, and without it CommandInput has no context to
          subscribe to. */}
      <Command>
        <CommandInput placeholder="Filter by project, sandbox or prompt…" />
        <CommandList>
          {activity.isLoading && (
            <div className="flex items-center gap-2 px-4 py-6 text-xs text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Loading…
            </div>
          )}
          {empty && <CommandEmpty>Nothing running or waiting.</CommandEmpty>}

          {blocked.length > 0 && (
            <CommandGroup heading="Waiting on you">
              {blocked.map((t) => (
                <Row key={t.id} entry={t} onSelect={go} accent />
              ))}
            </CommandGroup>
          )}

          {running.length > 0 && (
            <>
              {blocked.length > 0 && <CommandSeparator />}
              <CommandGroup heading="Running">
                {running.map((t) => (
                  <Row key={t.id} entry={t} onSelect={go} />
                ))}
              </CommandGroup>
            </>
          )}

          {unseen.length > 0 && (
            <>
              <CommandSeparator />
              <CommandGroup heading="Finished since you last looked">
                {unseen.map((t) => (
                  <Row key={t.id} entry={t} onSelect={go} />
                ))}
              </CommandGroup>
            </>
          )}

          {idle.length > 0 && (
            <>
              <CommandSeparator />
              <CommandGroup heading="Idle sandboxes">
                {idle.map((s) => (
                  <CommandItem
                    key={s.id}
                    value={`${s.name} ${s.projectName} sandbox`}
                    onSelect={() => go(s)}
                    className="gap-2"
                  >
                    <Server className="h-3.5 w-3.5 text-muted-foreground" />
                    <span className="truncate">{s.name}</span>
                    <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">
                      {s.projectName} · {s.provider}
                    </span>
                  </CommandItem>
                ))}
              </CommandGroup>
            </>
          )}
        </CommandList>
      </Command>
    </CommandDialog>
  );
}

function Row({
  entry,
  onSelect,
  accent,
}: {
  entry: ActivityEntry;
  onSelect: (e: ActivityEntry) => void;
  accent?: boolean;
}) {
  const dev = entry.taskKind === "dev";
  const Icon = accent ? CircleAlert : dev ? MessageSquareCode : Bot;
  const when = entry.finishedAt ?? entry.updatedAt;

  return (
    <CommandItem
      value={`${entry.title} ${entry.projectName} ${entry.sandboxName}`}
      onSelect={() => onSelect(entry)}
      className="gap-2"
    >
      <Icon
        className={`h-3.5 w-3.5 shrink-0 ${
          accent
            ? "text-amber-400"
            : entry.status === "error"
              ? "text-destructive"
              : "text-muted-foreground"
        }`}
      />
      <span className="truncate">{entry.title}</span>
      <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">
        {entry.projectName} · {entry.sandboxName}
        {when
          ? ` · ${formatDistanceToNow(new Date(when), { addSuffix: true })}`
          : ""}
      </span>
    </CommandItem>
  );
}
