"use client";

// App shell: persistent workspace sidebar on the left, and a column where
// each page renders its own topbar (AppHeader) + content.

import { useEffect, useState, type ReactNode } from "react";

import { AssistantPanel, OPEN_ASSISTANT_EVENT } from "@/components/assistant/assistant-panel";
import { OPEN_ACTIVITY_EVENT } from "@/components/layout/activity-indicator";
import { ActivitySwitcher } from "@/components/layout/activity-switcher";
import { StatusBar } from "@/components/layout/status-bar";
import { TaskToasts } from "@/components/layout/task-toasts";
import { WorkspaceSidebar } from "@/components/layout/workspace-sidebar";

const ASSISTANT_OPEN_KEY = "nexux:assistant:open";

export function AppShell({ children }: { children: ReactNode }) {
  // Mounted here rather than in AppHeader (where ⌘K lives): the point of this
  // one is to reach a run from wherever you are, including pages that render
  // no header at all.
  const [activityOpen, setActivityOpen] = useState(false);
  // The assistant (spec 30) docks beside the page rather than over it, so the
  // page stays usable while it works; ⌘I toggles it and the choice sticks.
  const [assistantOpen, setAssistantOpenState] = useState(false);
  useEffect(() => {
    try {
      setAssistantOpenState(localStorage.getItem(ASSISTANT_OPEN_KEY) === "1");
    } catch {
      // storage unavailable — starts closed
    }
  }, []);
  const setAssistantOpen = (open: boolean | ((v: boolean) => boolean)) =>
    setAssistantOpenState((prev) => {
      const next = typeof open === "function" ? open(prev) : open;
      try {
        localStorage.setItem(ASSISTANT_OPEN_KEY, next ? "1" : "0");
      } catch {
        // not remembered
      }
      return next;
    });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "j" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setActivityOpen((v) => !v);
      }
      if (e.key === "i" && (e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        setAssistantOpen((v) => !v);
      }
    };
    const onOpenAssistant = () => setAssistantOpen(true);
    window.addEventListener(OPEN_ASSISTANT_EVENT, onOpenAssistant);
    // The header's counter asks for the same overlay; it is a sibling several
    // components away, so it says so with an event rather than a prop chain.
    const onOpen = () => setActivityOpen(true);
    window.addEventListener("keydown", onKey);
    window.addEventListener(OPEN_ACTIVITY_EVENT, onOpen);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener(OPEN_ACTIVITY_EVENT, onOpen);
      window.removeEventListener(OPEN_ASSISTANT_EVENT, onOpenAssistant);
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
      {assistantOpen && <AssistantPanel onClose={() => setAssistantOpen(false)} />}
      <ActivitySwitcher open={activityOpen} onOpenChange={setActivityOpen} />
      <TaskToasts />
    </div>
  );
}
