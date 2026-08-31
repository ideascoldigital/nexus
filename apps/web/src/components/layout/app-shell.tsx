"use client";

// App shell: persistent workspace sidebar on the left, and a column where
// each page renders its own topbar (AppHeader) + content.

import { useEffect, useState, type ReactNode } from "react";

import { OPEN_ACTIVITY_EVENT } from "@/components/layout/activity-indicator";
import { ActivitySwitcher } from "@/components/layout/activity-switcher";
import { StatusBar } from "@/components/layout/status-bar";
import { TaskToasts } from "@/components/layout/task-toasts";
import { WorkspaceSidebar } from "@/components/layout/workspace-sidebar";

export function AppShell({ children }: { children: ReactNode }) {
  // Mounted here rather than in AppHeader (where ⌘K lives): the point of this
  // one is to reach a run from wherever you are, including pages that render
  // no header at all.
  const [activityOpen, setActivityOpen] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "j" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setActivityOpen((v) => !v);
      }
    };
    // The header's counter asks for the same overlay; it is a sibling several
    // components away, so it says so with an event rather than a prop chain.
    const onOpen = () => setActivityOpen(true);
    window.addEventListener("keydown", onKey);
    window.addEventListener(OPEN_ACTIVITY_EVENT, onOpen);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener(OPEN_ACTIVITY_EVENT, onOpen);
    };
  }, []);

  return (
    <div className="flex h-svh w-full overflow-hidden bg-background">
      <WorkspaceSidebar />
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          {children}
        </div>
        <StatusBar />
      </div>
      <ActivitySwitcher open={activityOpen} onOpenChange={setActivityOpen} />
      <TaskToasts />
    </div>
  );
}
