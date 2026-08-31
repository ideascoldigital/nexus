"use client";

// Persistent workspace nav — lives in AppShell so every page keeps it.
// Active state derives from the pathname. Collapses to an icon rail; the
// choice is persisted in localStorage and toggled with ⌘B / Ctrl+B.

import { Fragment, useEffect, useSyncExternalStore } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";

import { WorkspaceSwitcher } from "@/components/layout/workspace-switcher";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  Bot,
  FolderKanban,
  Hash,
  LayoutDashboard,
  PanelLeftClose,
  PanelLeftOpen,
  Settings,
} from "lucide-react";

const NAV = [
  { icon: LayoutDashboard, label: "Dashboard", href: "/" },
  { icon: FolderKanban, label: "Projects", href: "/projects" },
  { icon: Bot, label: "Agents", href: "/agents" },
  { icon: Hash, label: "Skills", href: "/skills" },
  { icon: Settings, label: "Settings", href: "/settings" },
];

const STORAGE_KEY = "nexux:sidebar-collapsed";

// localStorage as an external store: the server (and the first client render)
// see "expanded", then React swaps in the stored preference on hydration.
const listeners = new Set<() => void>();
const collapsedStore = {
  subscribe(onChange: () => void) {
    listeners.add(onChange);
    window.addEventListener("storage", onChange);
    return () => {
      listeners.delete(onChange);
      window.removeEventListener("storage", onChange);
    };
  },
  get: () => localStorage.getItem(STORAGE_KEY) === "1",
  set(collapsed: boolean) {
    localStorage.setItem(STORAGE_KEY, collapsed ? "1" : "0");
    listeners.forEach((l) => l());
  },
};

export function WorkspaceSidebar() {
  const pathname = usePathname();
  const collapsed = useSyncExternalStore(
    collapsedStore.subscribe,
    collapsedStore.get,
    () => false,
  );

  const toggle = () => collapsedStore.set(!collapsedStore.get());

  // ⌘B / Ctrl+B, matching the editor convention.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "b" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        toggle();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const isActive = (href: string) =>
    href === "/" ? pathname === "/" : pathname.startsWith(href);

  return (
    <aside
      data-collapsed={collapsed ? "" : undefined}
      className={`relative hidden shrink-0 flex-col gap-0.5 border-r border-border/60 bg-sidebar py-4 transition-[width] duration-200 ease-out md:flex ${
        collapsed ? "w-[60px] px-2" : "w-[210px] px-3"
      }`}
    >
      <WorkspaceSwitcher collapsed={collapsed} />

      {!collapsed && (
        <div className="px-2.5 py-1.5 font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground/70">
          Workspace
        </div>
      )}

      {NAV.map((n) => {
        const active = isActive(n.href);
        const link = (
          <Link
            href={n.href}
            aria-label={collapsed ? n.label : undefined}
            className={`flex items-center gap-2.5 rounded-lg py-2 text-[13.5px] transition-colors ${
              collapsed ? "justify-center px-0" : "px-3"
            } ${
              active
                ? "bg-accent font-semibold text-foreground"
                : "text-muted-foreground hover:bg-accent/40"
            }`}
          >
            <n.icon
              className={`h-4 w-4 shrink-0 ${
                active ? "text-accent-foreground" : "text-muted-foreground"
              }`}
              strokeWidth={1.75}
            />
            {!collapsed && n.label}
          </Link>
        );
        // Collapsed, the icon is all there is — name it on hover.
        return collapsed ? (
          <Tooltip key={n.href}>
            <TooltipTrigger render={link} />
            <TooltipContent side="right">{n.label}</TooltipContent>
          </Tooltip>
        ) : (
          <Fragment key={n.href}>{link}</Fragment>
        );
      })}

      <div
        className={`mt-auto flex items-center border-t border-border/60 pt-3 ${
          collapsed ? "justify-center" : "gap-2.5 px-2.5"
        }`}
      >
        {!collapsed && (
          <>
            <span className="h-2 w-2 rounded-full bg-primary" />
            <span className="font-mono text-[10.5px] text-muted-foreground">
              local-first · sqlite
            </span>
          </>
        )}
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                onClick={toggle}
                aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
                aria-expanded={!collapsed}
                className={`flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground ${
                  collapsed ? "" : "ml-auto"
                }`}
              >
                {collapsed ? (
                  <PanelLeftOpen className="h-4 w-4" strokeWidth={1.75} />
                ) : (
                  <PanelLeftClose className="h-4 w-4" strokeWidth={1.75} />
                )}
              </button>
            }
          />
          <TooltipContent side="right">
            {collapsed ? "Expand" : "Collapse"} sidebar · ⌘B
          </TooltipContent>
        </Tooltip>
      </div>
    </aside>
  );
}
