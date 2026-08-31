"use client";

import { useEffect, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { useToast } from "@/hooks/use-toast";
import { playTaskSound } from "@/lib/notification-sound";
import { getTasks, type TaskSummary } from "@/services/tasks";

const ACTIVE = ["queued", "running"];
// A running task whose log hasn't grown for this long is treated as stuck.
const STALL_MS = 10 * 60 * 1000;

type Props = { projectId: string };

/**
 * Watches sandbox tasks for the whole project and surfaces transitions as
 * toasts (done / failed / stuck). Nexus runs locally so instances can't call
 * back into it — we poll instead, which also survives page reloads.
 *
 * Mounted once on the project page; renders nothing.
 */
export function TaskNotifier({ projectId }: Props) {
  const { toast } = useToast();
  const qc = useQueryClient();

  const seen = useRef(new Map<string, string>());
  const stallWarned = useRef(new Set<string>());
  const primed = useRef(false);

  const tasks = useQuery({
    queryKey: ["tasks", projectId],
    queryFn: () => getTasks(projectId),
    refetchInterval: (query) =>
      query.state.data?.some((t) => ACTIVE.includes(t.status)) ? 5000 : 20000,
  });

  const data = tasks.data;

  const notifyTransition = (task: TaskSummary) => {
    const label = task.feature?.title ?? "Sandbox task";

    if (task.status === "completed") {
      stallWarned.current.delete(task.id);
      qc.invalidateQueries({ queryKey: ["features", projectId] });
      playTaskSound("success");
      toast({
        title: task.prUrl ? "Task done — PR ready" : "Task done",
        description: task.prUrl
          ? `${label}: ${task.prUrl}`
          : `${label}: ${task.error ?? "finished with no PR"}`,
      });
      return;
    }

    if (task.status === "error") {
      stallWarned.current.delete(task.id);
      qc.invalidateQueries({ queryKey: ["features", projectId] });
      playTaskSound("error");
      toast({
        title: "Task failed",
        description: `${label}: ${task.error ?? "unknown error"}`,
        variant: "destructive",
      });
    }
  };

  const maybeWarnStall = (task: TaskSummary) => {
    if (!ACTIVE.includes(task.status)) return;
    if (stallWarned.current.has(task.id)) return;
    const age = Date.now() - new Date(task.updatedAt).getTime();
    if (age < STALL_MS) return;
    stallWarned.current.add(task.id);
    playTaskSound("error");
    toast({
      title: "Task looks stuck",
      description: `${task.feature?.title ?? "Sandbox task"} hasn't produced output in ${Math.round(
        age / 60000,
      )} min on ${task.sandbox.name}. Check its log.`,
      variant: "destructive",
    });
  };

  useEffect(() => {
    if (!data) return;

    // First load only records current state — no toasts for old history.
    if (!primed.current) {
      primed.current = true;
      for (const t of data) seen.current.set(t.id, t.status);
      return;
    }

    for (const task of data) {
      const before = seen.current.get(task.id);
      seen.current.set(task.id, task.status);
      if (before === task.status) {
        maybeWarnStall(task);
        continue;
      }
      if (before === undefined) continue; // task created elsewhere; skip
      notifyTransition(task);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  return null;
}
