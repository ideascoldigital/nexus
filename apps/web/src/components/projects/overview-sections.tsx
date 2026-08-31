"use client";

// Stack / Orchestrate / Search as expandable sections on the Overview
// (design 1b accordions) with live meta + state on each header. Definition
// is not here — it's the Overview's hero panel. Content mounts only while a
// section is open (these are heavy canvases).

import { useQuery } from "@tanstack/react-query";
import { formatDistanceToNow } from "date-fns";
import {
  Boxes,
  ChevronDown,
  ChevronRight,
  ScanSearch,
  Workflow,
} from "lucide-react";

import { Card } from "@/components/ui/card";
import { StackCanvas } from "@/components/stack/stack-canvas";
import { OrchestrationCanvas } from "@/components/projects/orchestration-canvas";
import { ProjectSearchSetup } from "@/components/projects/project-search-setup";
import { getStack, getStackStatus } from "@/services/stack";
import {
  getIndexStatus,
  getProjectOrchestration,
} from "@/services/projects";

export type SetupSection = "stack" | "orchestration" | "search";

export function SetupSections({
  projectId,
  openSection,
  onToggle,
  onOpenSandboxes,
}: {
  projectId: string;
  openSection: SetupSection | null;
  onToggle: (section: SetupSection | null) => void;
  onOpenSandboxes?: () => void;
}) {
  const stack = useQuery({
    queryKey: ["project-stack", projectId],
    queryFn: () => getStack(projectId),
  });
  const stackStatus = useQuery({
    queryKey: ["stack-status", projectId],
    queryFn: () => getStackStatus(projectId),
    refetchInterval: 15_000,
  });
  const orchestration = useQuery({
    queryKey: ["project-orchestration", projectId],
    queryFn: () => getProjectOrchestration(projectId),
  });
  const index = useQuery({
    queryKey: ["embedding-index-status", projectId],
    queryFn: () => getIndexStatus(projectId),
  });

  const stackNodes = stack.data?.nodes ?? [];
  const services = stackNodes.filter((n) => n.kind === "service");
  const agents = orchestration.data?.agents.length ?? 0;
  const skills = orchestration.data?.skills.length ?? 0;
  const indexed = index.data?.total ?? 0;

  const sections: Array<{
    key: SetupSection;
    title: string;
    icon: typeof Boxes;
    meta: string;
    state: { label: string; className: string } | null;
  }> = [
    {
      key: "stack",
      title: "Stack",
      icon: Boxes,
      meta:
        stackNodes.length === 0
          ? "no stack — drag repos and services in"
          : `${stackNodes.length - services.length} repo${stackNodes.length - services.length !== 1 ? "s" : ""} · ${
              services.length > 0
                ? services.map((s) => s.name).slice(0, 3).join(", ")
                : "no services"
            }`,
      state: stackStatus.data?.running
        ? { label: "● up", className: "text-primary" }
        : stackNodes.length > 0
          ? { label: "down", className: "text-muted-foreground" }
          : null,
    },
    {
      key: "orchestration",
      title: "Orchestrate",
      icon: Workflow,
      meta:
        agents === 0 && skills === 0
          ? "no agents or skills — drag them in from the catalog"
          : `${agents} agente${agents !== 1 ? "s" : ""} · ${skills} skill${skills !== 1 ? "s" : ""} adjuntas`,
      state: null,
    },
    {
      key: "search",
      title: "Search",
      icon: ScanSearch,
      meta:
        indexed === 0
          ? "not indexed — indexing runs automatically"
          : `${indexed} sources · 3 buckets · incremental by hash`,
      state: index.data?.lastIndexedAt
        ? {
            label: formatDistanceToNow(new Date(index.data.lastIndexedAt), {
              addSuffix: true,
            }),
            className: "text-muted-foreground",
          }
        : null,
    },
  ];

  return (
    <div className="space-y-2">
      {sections.map((s) => {
        const open = openSection === s.key;
        return (
          <Card
            key={s.key}
            className="border-border/50 py-0 gap-0 overflow-hidden"
          >
            <button
              type="button"
              onClick={() => onToggle(open ? null : s.key)}
              className="flex w-full items-center gap-2.5 px-4 py-3 text-left hover:bg-muted/30 transition-colors"
            >
              {open ? (
                <ChevronDown className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
              ) : (
                <ChevronRight className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
              )}
              <s.icon className="h-4 w-4 text-primary shrink-0" />
              <span className="text-sm font-medium shrink-0">{s.title}</span>
              <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground">
                {s.meta}
              </span>
              {s.state && (
                <span
                  className={`shrink-0 font-mono text-[10px] ${s.state.className}`}
                >
                  {s.state.label}
                </span>
              )}
            </button>
            {open && (
              <div className="border-t border-border/40 p-4">
                {s.key === "stack" && (
                  <StackCanvas
                    projectId={projectId}
                    onOpenSandboxes={onOpenSandboxes}
                  />
                )}
                {s.key === "orchestration" && (
                  <OrchestrationCanvas projectId={projectId} />
                )}
                {s.key === "search" && (
                  <ProjectSearchSetup projectId={projectId} />
                )}
              </div>
            )}
          </Card>
        );
      })}
    </div>
  );
}
