"use client";

import { Badge } from "@/components/ui/badge";
import { Paperclip } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  MessageSquareCode,
  CircleDot,
  BookOpen,
  GitPullRequest,
  Milestone,
  NotebookPen,
} from "lucide-react";
import type { FeatureWithCounts } from "@/services/features";
import type { FeatureStatus, FeaturePriority } from "@/types";

const statusConfig: Record<
  FeatureStatus,
  { label: string; className: string }
> = {
  backlog: {
    label: "Backlog",
    className: "bg-slate-500/10 text-slate-400 border-slate-500/20",
  },
  todo: {
    label: "Todo",
    className: "bg-blue-500/10 text-blue-400 border-blue-500/20",
  },
  queued: {
    label: "Queue",
    className: "bg-primary/10 text-primary border-primary/30",
  },
  in_progress: {
    label: "In Progress",
    className: "bg-amber-500/10 text-amber-400 border-amber-500/20",
  },
  in_review: {
    label: "In Review",
    className: "bg-violet-500/10 text-violet-400 border-violet-500/20",
  },
  done: {
    label: "Done",
    className: "bg-emerald-500/10 text-emerald-400 border-emerald-500/20",
  },
};

const priorityConfig: Record<
  FeaturePriority,
  { label: string; dotClassName: string }
> = {
  low: { label: "Low", dotClassName: "bg-slate-400" },
  medium: { label: "Medium", dotClassName: "bg-blue-400" },
  high: { label: "High", dotClassName: "bg-amber-400" },
  urgent: { label: "Urgent", dotClassName: "bg-red-400 animate-pulse" },
};

/** "MR !280" / "PR #12" out of the link — the number is the identity. */
export function prLabel(url: string): string {
  const gl = url.match(/\/-\/merge_requests\/(\d+)/);
  if (gl) return `MR !${gl[1]}`;
  const gh = url.match(/\/pull\/(\d+)/);
  if (gh) return `PR #${gh[1]}`;
  return "PR";
}

interface FeatureCardProps {
  feature: FeatureWithCounts;
  onClick?: (feature: FeatureWithCounts) => void;
  onRun?: (feature: FeatureWithCounts) => void;
  /** When set, the card is draggable (kanban column moves). */
  onDragStart?: (feature: FeatureWithCounts, e: React.DragEvent) => void;
}

export function FeatureCard({
  feature,
  onClick,
  onRun,
  onDragStart,
}: FeatureCardProps) {
  const status = statusConfig[feature.status as FeatureStatus] ?? statusConfig.backlog;
  const priority = priorityConfig[feature.priority as FeaturePriority] ?? priorityConfig.medium;
  const conversationCount = feature._count.conversations;
  const issueCount = feature._count.featureIssues;
  const sourceKeys = Array.isArray(feature.sourceSectionKeys)
    ? (feature.sourceSectionKeys as string[])
    : [];

  return (
    <div
      className={cn(
        "group relative rounded-lg border border-border/50 bg-card transition-colors hover:border-border focus-within:border-ring",
        onDragStart && "cursor-grab active:cursor-grabbing"
      )}
      draggable={!!onDragStart}
      onDragStart={onDragStart ? (e) => onDragStart(feature, e) : undefined}
    >
      <button
        type="button"
        onClick={() => onClick?.(feature)}
        className={cn(
          "w-full text-left p-3 cursor-pointer rounded-lg",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
        )}
      >
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <span
              className={cn("h-2 w-2 rounded-full shrink-0", priority.dotClassName)}
              title={priority.label}
            />
            <span className="text-sm font-medium truncate">{feature.title}</span>
            {Array.isArray(feature.attachments) &&
              feature.attachments.length > 0 && (
                <span
                  className="inline-flex shrink-0 items-center gap-0.5 text-[10px] text-muted-foreground"
                  title={`${feature.attachments.length} attachment(s)`}
                >
                  <Paperclip className="h-3 w-3" />
                  {feature.attachments.length}
                </span>
              )}
          </div>
          <Badge
            variant="outline"
            className={cn(
              "shrink-0 text-[10px] h-5",
              status.className,
              onRun && feature.status !== "done" && "mr-16"
            )}
          >
            {status.label}
          </Badge>
        </div>

        {feature.description && (
          <p className="mt-1.5 text-xs text-muted-foreground line-clamp-2 pl-4">
            {feature.description}
          </p>
        )}

        {(conversationCount > 0 ||
          issueCount > 0 ||
          feature.devPhase ||
          feature.planStatus ||
          sourceKeys.length > 0) && (
          <div className="mt-2 flex flex-wrap items-center gap-3 pl-4 text-xs text-muted-foreground">
            {feature.planStatus && (
              <span
                className={cn(
                  "flex items-center gap-1",
                  feature.planStatus === "approved" && "text-emerald-400",
                )}
                title={`Plan: ${feature.planStatus.replace("_", " ")}`}
              >
                <NotebookPen className="h-3 w-3" />
                plan
              </span>
            )}
            {feature.devPhase && (
              <span
                className="flex items-center gap-1"
                title={`Dev phase: ${feature.devPhase.name}`}
              >
                <Milestone className="h-3 w-3" />
                {feature.devPhase.name}
              </span>
            )}
            {sourceKeys.length > 0 && (
              <span
                className="flex items-center gap-1"
                title={`From definition: ${sourceKeys.join(", ")}`}
              >
                <BookOpen className="h-3 w-3" />
                definition
              </span>
            )}
            {conversationCount > 0 && (
              <span className="flex items-center gap-1">
                <MessageSquareCode className="h-3 w-3" />
                {conversationCount} conversation{conversationCount !== 1 ? "s" : ""}
              </span>
            )}
            {issueCount > 0 && (
              <span className="flex items-center gap-1">
                <CircleDot className="h-3 w-3" />
                {issueCount} issue{issueCount !== 1 ? "s" : ""}
              </span>
            )}
          </div>
        )}
      </button>

      {/* PR/MR links live outside the button — a nested anchor inside it
          would be invalid HTML and fight the card's own click. */}
      {(feature.prUrls?.length ?? 0) > 0 && (
        <div className="-mt-1 flex flex-wrap items-center gap-1.5 px-3 pb-2.5 pl-7">
          {feature.prUrls!.map((url) => (
            <a
              key={url}
              href={url}
              target="_blank"
              rel="noreferrer"
              title={url}
              className="flex items-center gap-1 rounded-full border border-violet-500/20 bg-violet-500/10 px-2 py-0.5 text-[10px] text-violet-300 transition-colors hover:bg-violet-500/20"
            >
              <GitPullRequest className="h-2.5 w-2.5" />
              {prLabel(url)}
            </a>
          ))}
        </div>
      )}

      {/* A done feature has nothing left to run — and running it would
          re-provision the sandbox that closing it just destroyed. */}
      {onRun && feature.status !== "done" && (
        <Button
          size="sm"
          variant="outline"
          onClick={() => onRun(feature)}
          className="absolute right-2 top-2 gap-1 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
          title="Run this feature on a sandbox with Claude Code"
        >
          Run
        </Button>
      )}
    </div>
  );
}

export { statusConfig, priorityConfig };
