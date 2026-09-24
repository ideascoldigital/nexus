// One number, told straight: micro-uppercase label, mono tabular value,
// a quiet sub-line. Pure (no hooks) so server and client pages share it.

import { type ReactNode } from "react";
import { cn } from "@/lib/utils";

export function StatTile({
  label,
  value,
  sub,
  aside,
  className,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  /** Right-side garnish — a sparkline, an icon. Wears its own color. */
  aside?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex items-center justify-between gap-3 rounded-xl border border-border/50 bg-card p-4",
        className,
      )}
    >
      <div className="min-w-0">
        <div className="text-[10px] font-semibold tracking-[0.14em] text-muted-foreground/80 uppercase">
          {label}
        </div>
        <div className="mt-1 font-mono text-xl leading-none font-semibold tabular-nums">
          {value}
        </div>
        {/* The sub-line wraps below md — at two tiles per row a phone gives it
            ~132px, and "features · 0 plans awaiting approval" needs 185. A
            count you cannot read is not a stat. */}
        {sub && (
          <div className="mt-1.5 text-[11px] text-muted-foreground md:truncate">
            {sub}
          </div>
        )}
      </div>
      {aside && <div className="shrink-0">{aside}</div>}
    </div>
  );
}
