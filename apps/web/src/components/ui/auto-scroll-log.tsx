"use client";

import { useEffect, useRef } from "react";

import { cn } from "@/lib/utils";

/**
 * Streaming log view. Follows the tail as new output arrives, but stops
 * following the moment the user scrolls up to read — and resumes when they
 * scroll back to the bottom.
 *
 * break-all matters: terraform and Claude emit very long lines with no spaces
 * to wrap on, which would otherwise widen the container past its parent.
 */
export function AutoScrollLog({
  text,
  className,
}: {
  text: string;
  className?: string;
}) {
  const ref = useRef<HTMLPreElement>(null);
  const stick = useRef(true);

  useEffect(() => {
    const el = ref.current;
    if (!el || !stick.current) return;
    el.scrollTop = el.scrollHeight;
  }, [text]);

  return (
    <pre
      ref={ref}
      onScroll={(e) => {
        const el = e.currentTarget;
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
      }}
      className={cn(
        "max-h-64 overflow-y-auto p-3 text-[11px] leading-snug break-all whitespace-pre-wrap text-muted-foreground",
        className,
      )}
    >
      {text}
    </pre>
  );
}
