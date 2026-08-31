"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Eraser } from "lucide-react";

import { Button } from "@/components/ui/button";
import { streamStackLogs } from "@/services/stack";
import type { StackLogLine } from "@/lib/stack/types";

const MAX_CLIENT_LINES = 2000;

const ANSI_RE = /\x1b\[[0-9;?]*[a-zA-Z]/g;
const stripAnsi = (s: string) => s.replace(ANSI_RE, "");

const SOURCE_COLORS = [
  "text-blue-400",
  "text-purple-400",
  "text-emerald-400",
  "text-amber-400",
  "text-pink-400",
  "text-cyan-400",
];

function sourceColor(source: string): string {
  if (source === "compose" || source === "runner") return "text-muted-foreground";
  let hash = 0;
  for (let i = 0; i < source.length; i++) {
    hash = (hash * 31 + source.charCodeAt(i)) | 0;
  }
  return SOURCE_COLORS[Math.abs(hash) % SOURCE_COLORS.length];
}

type Props = {
  projectId: string;
  active: boolean; // stream while the stack is (or is being brought) up
  /** Lets the parent give the panel room only while it is expanded. */
  onOpenChange?: (open: boolean) => void;
};

/** A log line plus a key that stays unique across runner restarts. */
type ClientLogLine = StackLogLine & { key: number };

export function StackLogsPanel({ projectId, active, onOpenChange }: Props) {
  const [open, setOpen] = useState(false);
  const [lines, setLines] = useState<ClientLogLine[]>([]);
  const [filter, setFilter] = useState<string>("all");
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const lineKey = useRef(0);

  // auto-open the panel when the stack transitions to running
  const [prevActive, setPrevActive] = useState(active);
  if (active !== prevActive) {
    setPrevActive(active);
    if (active) setOpen(true);
  }

  // Tell the parent how much room to give us (collapsed = header only).
  useEffect(() => {
    onOpenChange?.(open);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!active) return;
    const abort = streamStackLogs(projectId, (line) => {
      setLines((prev) => {
        // The server's `seq` restarts at 1 whenever the runner rebuilds its
        // in-memory run (a dev-server restart), so it is not unique across the
        // list the client accumulates. Stamp our own monotonic key instead.
        const next = [...prev, { ...line, key: ++lineKey.current }];
        return next.length > MAX_CLIENT_LINES
          ? next.slice(-MAX_CLIENT_LINES)
          : next;
      });
    });
    return abort;
  }, [projectId, active]);

  useEffect(() => {
    if (!stickToBottom.current || !scrollRef.current) return;
    scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [lines, open]);

  const sources = useMemo(() => {
    const s = new Set<string>();
    lines.forEach((l) => s.add(l.source));
    return ["all", ...Array.from(s).sort()];
  }, [lines]);

  const visible = useMemo(
    () => (filter === "all" ? lines : lines.filter((l) => l.source === filter)),
    [lines, filter]
  );

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    stickToBottom.current =
      el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  };

  return (
    <div className="flex h-full min-h-0 flex-col border-t bg-background">
      <div className="flex shrink-0 items-center gap-2 px-3 py-1.5">
        <Button
          size="sm"
          variant="ghost"
          className="h-7 px-2 text-sm"
          onClick={() => setOpen((o) => !o)}
        >
          Logs ({lines.length})
        </Button>
        {open ? (
          <>
            <div className="flex flex-wrap gap-1">
              {sources.map((s) => (
                <button
                  key={s}
                  onClick={() => setFilter(s)}
                  className={`text-xs px-2 py-0.5 rounded border ${
                    filter === s
                      ? "bg-primary text-primary-foreground border-primary"
                      : "bg-transparent text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {s}
                </button>
              ))}
            </div>
            <div className="flex-1" />
            <Button
              size="sm"
              variant="ghost"
              className="h-6 px-1.5"
              onClick={() => setLines([])}
              title="Clear"
            >
              <Eraser className="h-3 w-3" />
            </Button>
          </>
        ) : null}
      </div>
      {open ? (
        <div
          ref={scrollRef}
          onScroll={onScroll}
          className="min-h-0 flex-1 overflow-auto border-t bg-black/40 px-3 py-2 font-mono text-[13px] leading-5"
        >
          {visible.length === 0 ? (
            <span className="text-muted-foreground">No output yet.</span>
          ) : (
            visible.map((l) => (
              <div key={l.key} className="whitespace-pre-wrap break-all">
                <span className={`${sourceColor(l.source)} select-none`}>
                  [{l.source}]{" "}
                </span>
                {stripAnsi(l.line)}
              </div>
            ))
          )}
        </div>
      ) : null}
    </div>
  );
}
