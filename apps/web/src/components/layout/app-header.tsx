"use client";

// Global topbar ("Nexus Prototype" design): compact mark + Nexus → dashboard,
// `/ context` breadcrumb, health pills, ⌕ search ⌘K and + New Project.

import { useEffect, useState } from "react";
import Link from "next/link";
import { BotMessageSquare } from "lucide-react";

import { ActivityIndicator } from "@/components/layout/activity-indicator";
import { CommandPalette } from "@/components/layout/command-palette";
import { NotificationBell } from "@/components/layout/notification-bell";
import { NexusLogoTile } from "@/components/brand/nexus-mark";

export function AppHeader({ title }: { title?: string }) {
  const [paletteOpen, setPaletteOpen] = useState(false);

  // Global ⌘K / Ctrl+K.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "k" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setPaletteOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const breadcrumb = title && title !== "Dashboard" ? title : null;

  return (
    // Also the window's title bar in the macOS app: drag on any empty spot.
    <header data-tauri-drag-region className="flex h-12 shrink-0 items-center gap-3.5 border-b border-border/60 bg-sidebar px-5">
      <Link
        href="/"
        className="flex items-center gap-2.5 hover:opacity-85 transition-opacity"
      >
        <NexusLogoTile size={26} />
        <span className="text-[15px] font-bold">Nexus</span>
      </Link>
      {breadcrumb && (
        <span className="truncate font-mono text-[11.5px] text-muted-foreground">
          / {breadcrumb}
        </span>
      )}

      <div className="ml-auto flex items-center gap-2.5">
        {/* The simple view (spec 23): bots only, outside this shell. */}
        <Link
          href="/bots"
          className="flex items-center gap-1.5 rounded-lg border border-primary/40 bg-primary/10 px-3 py-1.5 text-[12px] font-medium text-accent-foreground transition-colors hover:bg-primary/20"
          title="Open the simple view: your bots and nothing else"
        >
          <BotMessageSquare className="h-3.5 w-3.5" strokeWidth={1.75} />
          Bots
        </Link>
        <button
          type="button"
          onClick={() => setPaletteOpen(true)}
          className="flex w-[21rem] max-w-[40vw] items-center gap-2 rounded-lg border border-border/70 px-3 py-1.5 font-mono text-[11px] text-muted-foreground transition-colors hover:border-primary/40 hover:text-accent-foreground"
          title="Search everything"
        >
          ⌕ search
          <kbd className="ml-auto rounded bg-muted px-1.5 text-[10px]">⌘K</kbd>
        </button>
        <ActivityIndicator />
        <NotificationBell />
      </div>

      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />
    </header>
  );
}
