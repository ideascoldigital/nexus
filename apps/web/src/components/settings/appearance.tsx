"use client";

import { useSyncExternalStore } from "react";
import {
  Check,
  Columns3,
  Maximize2,
  Minus,
  Monitor,
  Moon,
  Palette,
  Plus,
  Sun,
  ZoomIn,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { useCanZoom, useZoom } from "@/components/layout/zoom-control";
import {
  layoutWidthStore,
  themeStore,
  zoomStore,
  ZOOM_STEPS,
  type LayoutWidth,
  type Theme,
} from "@/lib/appearance";

/** A row of mutually exclusive cards — the same shape as the other pickers. */
function Choice<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: Array<{ value: T; title: string; desc: string; icon: typeof Columns3 }>;
  onChange: (v: T) => void;
}) {
  return (
    <div className={`grid gap-2 ${options.length === 3 ? "sm:grid-cols-3" : "sm:grid-cols-2"}`}>
      {options.map((o) => {
        const selected = value === o.value;
        return (
          <button
            key={o.value}
            type="button"
            onClick={() => onChange(o.value)}
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
  );
}

/** Width, zoom and theme. Per viewer (this browser / this app), applied at once. */
export function AppearanceSection() {
  const width = useSyncExternalStore(
    layoutWidthStore.subscribe,
    layoutWidthStore.get,
    () => "contained" as LayoutWidth,
  );
  const theme = useSyncExternalStore(themeStore.subscribe, themeStore.get, () => "dark" as Theme);
  const zoom = useZoom();
  const canZoom = useCanZoom();

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Palette className="h-5 w-5" />
            Theme
          </CardTitle>
          <CardDescription>Nexus is drawn dark first; light and following the system are here too.</CardDescription>
        </CardHeader>
        <CardContent>
          <Choice
            value={theme}
            onChange={(t) => themeStore.set(t)}
            options={[
              { value: "dark", title: "Dark", desc: "The default.", icon: Moon },
              { value: "light", title: "Light", desc: "For bright rooms and screenshots.", icon: Sun },
              { value: "system", title: "System", desc: "Follows your OS, and changes with it.", icon: Monitor },
            ]}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <ZoomIn className="h-5 w-5" />
            Zoom
          </CardTitle>
          <CardDescription>
            {canZoom
              ? "Also in the status bar and on ⌘+ / ⌘− / ⌘0 — all three move the same setting, and it is kept for the next launch."
              : "In a browser, use its own zoom — ⌘+ / ⌘− (Ctrl on Windows and Linux). The desktop app has its own control here."}
          </CardDescription>
        </CardHeader>
        {canZoom && (
        <CardContent className="flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            size="icon-sm"
            onClick={() => zoomStore.step("out")}
            disabled={zoom <= ZOOM_STEPS[0]}
            aria-label="Zoom out"
          >
            <Minus className="h-3.5 w-3.5" />
          </Button>
          <span className="min-w-[3.5rem] text-center font-mono text-sm">{Math.round(zoom * 100)}%</span>
          <Button
            variant="outline"
            size="icon-sm"
            onClick={() => zoomStore.step("in")}
            disabled={zoom >= ZOOM_STEPS.at(-1)!}
            aria-label="Zoom in"
          >
            <Plus className="h-3.5 w-3.5" />
          </Button>
          <div className="ml-2 flex flex-wrap gap-1">
            {[0.9, 1, 1.1, 1.25].map((z) => (
              <Button
                key={z}
                variant={Math.abs(zoom - z) < 1e-6 ? "secondary" : "ghost"}
                size="sm"
                className="font-mono text-xs"
                onClick={() => zoomStore.set(z)}
              >
                {Math.round(z * 100)}%
              </Button>
            ))}
          </div>
        </CardContent>
        )}
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Columns3 className="h-5 w-5" />
            Page width
          </CardTitle>
          <CardDescription>
            On a window narrower than ~1200px the two look the same — the
            contained column is already using all of it.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Choice
            value={width}
            onChange={(w) => layoutWidthStore.set(w)}
            options={[
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
            ]}
          />
        </CardContent>
      </Card>

      <p className="text-[11px] text-muted-foreground">
        All of these are remembered on this device — the desktop app and the
        browser each keep their own, since they are usually different windows
        on different screens.
      </p>
    </div>
  );
}
