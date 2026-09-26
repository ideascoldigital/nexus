"use client";

import { useSyncExternalStore } from "react";
import { Check, Columns3, Maximize2 } from "lucide-react";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { layoutWidthStore, type LayoutWidth } from "@/lib/layout-width";

const OPTIONS: Array<{
  value: LayoutWidth;
  title: string;
  desc: string;
  icon: typeof Columns3;
}> = [
  {
    value: "contained",
    title: "Contained",
    desc: "A centred column, as designed — line lengths and card grids keep their proportions on a wide screen.",
    icon: Columns3,
  },
  {
    value: "full",
    title: "Full width",
    desc: "Every page uses the whole window — more room for the canvas, the rails and long tables.",
    icon: Maximize2,
  },
];

/** How wide pages are. Per viewer (this browser / this app), applied at once. */
export function AppearanceSection() {
  const width = useSyncExternalStore(
    layoutWidthStore.subscribe,
    layoutWidthStore.get,
    () => "contained" as LayoutWidth,
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Columns3 className="h-5 w-5" />
          Page width
        </CardTitle>
        <CardDescription>
          Remembered on this device — the desktop app and the browser each keep
          their own, since they are usually different windows on different
          screens.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="grid gap-2 sm:grid-cols-2">
          {OPTIONS.map((o) => {
            const selected = width === o.value;
            return (
              <button
                key={o.value}
                type="button"
                onClick={() => layoutWidthStore.set(o.value)}
                aria-pressed={selected}
                className={`flex items-start gap-3 rounded-lg border p-3 text-left transition-colors ${
                  selected
                    ? "border-primary/60 bg-primary/10"
                    : "border-border/60 bg-muted/20 hover:border-border"
                }`}
              >
                <o.icon
                  className={`mt-0.5 h-4 w-4 shrink-0 ${selected ? "text-primary" : "text-muted-foreground"}`}
                />
                <span className="min-w-0">
                  <span className="block text-xs font-medium">{o.title}</span>
                  <span className="block text-[11px] text-muted-foreground">{o.desc}</span>
                </span>
                {selected && <Check className="ml-auto h-4 w-4 shrink-0 text-primary" />}
              </button>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}
