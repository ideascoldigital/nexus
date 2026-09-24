"use client";

// Global topbar ("Nexus Prototype" design): compact mark + Nexus → dashboard,
// `/ context` breadcrumb, health pills, ⌕ search ⌘K and + New Project.

import { useEffect, useState } from "react";
import Link from "next/link";

import { ActivityIndicator } from "@/components/layout/activity-indicator";
import { CommandPalette } from "@/components/layout/command-palette";
import { NotificationBell } from "@/components/layout/notification-bell";
import { NexusLogoTile } from "@/components/brand/nexus-mark";
import { MobileNav } from "@/components/layout/mobile-nav";

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
    <header className="flex h-12 shrink-0 items-center gap-3.5 border-b border-border/60 bg-sidebar px-5">
      {/* The only way to reach another page below md, where the sidebar is
          hidden. */}
      <MobileNav />
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
        <button
          type="button"
          onClick={() => setPaletteOpen(true)}
          // h-9 below sm so the one control every screen carries is a real
          // target; py-1.5 (31px) is fine for a cursor and thin for a thumb.
          className="flex h-9 w-[21rem] max-w-[40vw] items-center gap-2 rounded-lg border border-border/70 px-3 font-mono text-[11px] text-muted-foreground transition-colors hover:border-primary/40 hover:text-accent-foreground sm:h-auto sm:py-1.5"
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
