"use client";

import { useMemo, useState } from "react";
import {
  GripVertical,
  Search,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { Repository } from "@nexux/db";
import { SERVICE_CATALOG, type ServiceDef } from "@/lib/stack/service-catalog";
import type { DetectionResult } from "@/lib/stack/types";

export const STACK_DRAG_MIME = "application/x-nexux-stack";

export type StackDragPayload =
  | { kind: "repo"; repositoryId: string; name: string }
  | { kind: "service"; serviceKey: string };

type Props = {
  repositories: Repository[];
  detections: Record<string, DetectionResult>;
  onCanvasRepoIds: Set<string>;
};

export function StackSidebar({
  repositories,
  detections,
  onCanvasRepoIds,
}: Props) {
  const [query, setQuery] = useState("");
  const [tab, setTab] = useState<"repos" | "services">("repos");

  const q = query.trim().toLowerCase();
  const filteredRepos = useMemo(
    () =>
      repositories.filter((r) =>
        q ? r.name.toLowerCase().includes(q) : true
      ),
    [repositories, q]
  );
  const filteredServices = useMemo(
    () =>
      SERVICE_CATALOG.filter((s) =>
        q
          ? s.name.toLowerCase().includes(q) ||
            s.image.toLowerCase().includes(q)
          : true
      ),
    [q]
  );

  const onDragStart = (e: React.DragEvent, payload: StackDragPayload) => {
    e.dataTransfer.setData(STACK_DRAG_MIME, JSON.stringify(payload));
    e.dataTransfer.effectAllowed = "copy";
  };

  return (
    <div className="flex h-full w-full min-w-0 flex-col gap-2 border-r bg-card/40 p-3">
      <div className="flex gap-1">
        <Button
          size="sm"
          variant={tab === "repos" ? "default" : "outline"}
          className="flex-1 h-8 text-sm"
          onClick={() => setTab("repos")}
        >
          Repos ({repositories.length})
        </Button>
        <Button
          size="sm"
          variant={tab === "services" ? "default" : "outline"}
          className="flex-1 h-8 text-sm"
          onClick={() => setTab("services")}
        >
          Services
        </Button>
      </div>

      <div className="relative">
        <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search..."
          className="h-8 pl-7 text-sm"
        />
      </div>

      <div className="flex-1 overflow-auto -mx-1 px-1 space-y-1">
        {tab === "repos" ? (
          filteredRepos.length === 0 ? (
            <div className="text-sm text-muted-foreground text-center py-4">
              No repositories with a local path
            </div>
          ) : (
            filteredRepos.map((r) => {
              const onCanvas = onCanvasRepoIds.has(r.id);
              const detection = detections[r.id];
              const draggable = !onCanvas && !!r.localPath;
              return (
                <div
                  key={r.id}
                  draggable={draggable}
                  onDragStart={(e) =>
                    onDragStart(e, {
                      kind: "repo",
                      repositoryId: r.id,
                      name: r.name,
                    })
                  }
                  className={`group flex flex-col gap-0.5 rounded-md border bg-background px-2.5 py-2 text-sm ${
                    draggable
                      ? "cursor-grab active:cursor-grabbing hover:border-primary/60"
                      : "opacity-50"
                  }`}
                  title={r.localPath ?? r.name}
                >
                  <div className="flex items-center gap-2">
                    <GripVertical className="h-3 w-3 text-muted-foreground" />
                    <span className="truncate flex-1 font-medium">
                      {r.name}
                    </span>
                    {onCanvas ? (
                      <Badge variant="outline" className="text-[11px]">
                        on canvas
                      </Badge>
                    ) : null}
                  </div>
                  <div className="flex flex-wrap gap-1 ml-5">
                    {!r.localPath ? (
                      <Badge variant="outline" className="text-[11px]">
                        no local path
                      </Badge>
                    ) : null}
                    {detection?.hasDockerfile ? (
                      <Badge variant="outline" className="text-[11px]">
                        Dockerfile ✓
                      </Badge>
                    ) : null}
                    {detection?.hasMakefile ? (
                      <Badge variant="outline" className="text-[11px]">
                        Makefile ✓
                      </Badge>
                    ) : null}
                    {detection?.packageManager ? (
                      <Badge variant="outline" className="text-[11px]">
                        {detection.packageManager}
                      </Badge>
                    ) : null}
                  </div>
                </div>
              );
            })
          )
        ) : (
          filteredServices.map((s: ServiceDef) => (
            <div
              key={s.key}
              draggable
              onDragStart={(e) =>
                onDragStart(e, { kind: "service", serviceKey: s.key })
              }
              className="group flex flex-col gap-0.5 rounded-md border bg-background px-2.5 py-2 text-sm cursor-grab active:cursor-grabbing hover:border-primary/60"
              title={s.description}
            >
              <div className="flex items-center gap-2">
                <GripVertical className="h-3 w-3 text-muted-foreground" />
                <span className="truncate flex-1 font-medium">{s.name}</span>
                <Badge variant="outline" className="text-[11px] font-mono">
                  {s.image}
                </Badge>
              </div>
              <span className="text-xs text-muted-foreground ml-5">
                {s.description}
              </span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
