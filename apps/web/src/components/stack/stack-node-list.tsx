"use client";

import { Boxes, GitBranch, Server } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { nodePhases } from "@/lib/stack/phases";
import type { StackNodeDTO } from "@/lib/stack/types";

/**
 * The stack as a list, for widths a canvas cannot survive.
 *
 * At 375px the React Flow canvas is 180px of viewport — a node graph you
 * cannot read, let alone drag. And dragging is the interaction it exists for,
 * which is not one a phone offers well anyway.
 *
 * So this is deliberately **read-only**. It answers what a phone is for here —
 * what is in this stack, what runs it, what depends on what — and leaves
 * editing to a machine with a pointer. Offering half an editor would invite
 * changes the surface cannot actually support.
 */
export function StackNodeList({
  nodes,
  edges,
}: {
  nodes: StackNodeDTO[];
  edges: Array<{ sourceId: string; targetId: string }>;
}) {
  if (!nodes.length) {
    return (
      <p className="px-1 py-6 text-center text-xs text-muted-foreground">
        Your stack is empty. Open this project on a larger screen to add repos
        and services.
      </p>
    );
  }

  const nameOf = (id: string) => nodes.find((n) => n.id === id)?.name ?? id;
  // Dependencies per node, resolved once rather than per row.
  const dependsOn = new Map<string, string[]>();
  for (const edge of edges) {
    dependsOn.set(edge.sourceId, [
      ...(dependsOn.get(edge.sourceId) ?? []),
      nameOf(edge.targetId),
    ]);
  }

  return (
    <div className="space-y-2">
      {nodes.map((node) => {
        const phases = nodePhases(node);
        const run = phases.find((p) => p.role === "run")?.command;
        const install = phases.find((p) => p.role === "install")?.command;
        const deps = dependsOn.get(node.id) ?? [];
        const ports = (node.ports ?? [])
          .map((p) => (p.host === p.container ? `${p.host}` : `${p.host}:${p.container}`))
          .join(", ");

        return (
          <div
            key={node.id}
            className="rounded-lg border border-border/50 bg-card/40 p-3"
          >
            <div className="flex items-start gap-2">
              {node.kind === "service" ? (
                <Server className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
              ) : (
                <Boxes className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
              )}
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="truncate text-sm font-medium">{node.name}</span>
                  <Badge variant="outline" className="text-[10px]">
                    {node.runMode}
                  </Badge>
                  {ports ? (
                    <span className="font-mono text-[10px] text-muted-foreground">
                      :{ports}
                    </span>
                  ) : null}
                </div>

                {node.image ? (
                  <div className="mt-1 truncate font-mono text-[11px] text-muted-foreground">
                    {node.image}
                  </div>
                ) : null}

                {/* The commands, because "what would this actually run" is the
                    question a canvas answers by being opened node by node. */}
                {install ? (
                  <div className="mt-1 truncate font-mono text-[11px] text-muted-foreground">
                    <span className="text-muted-foreground/60">install </span>
                    {install}
                  </div>
                ) : null}
                {run ? (
                  <div className="truncate font-mono text-[11px] text-emerald-500/80">
                    <span className="text-muted-foreground/60">run </span>
                    {run}
                  </div>
                ) : null}

                {deps.length ? (
                  <div className="mt-1.5 flex items-center gap-1 text-[11px] text-muted-foreground">
                    <GitBranch className="h-3 w-3 shrink-0" />
                    <span className="truncate">needs {deps.join(", ")}</span>
                  </div>
                ) : null}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
