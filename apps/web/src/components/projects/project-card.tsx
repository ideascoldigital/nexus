"use client";

import Link from "next/link";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  GitFork,
  MessageSquareCode,
  Clock,
  FolderGit2,
  Sparkles,
} from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import type { ProjectWithCounts } from "@/services/projects";
import { getBootstrapTemplate } from "@/lib/bootstrap/templates";

export function ProjectCard({ project }: { project: ProjectWithCounts }) {
  const repoCount = project._count.repositories;
  const readyCount = project.repositories.filter(
    (r) => r.cloneStatus === "ready"
  ).length;
  const bootstrapTemplate = project.bootstrapType
    ? getBootstrapTemplate(project.bootstrapType)
    : undefined;

  return (
    <Link href={`/projects/${project.id}`}>
      <Card className="group relative overflow-hidden border-border/50 hover:border-border transition-colors cursor-pointer h-full">
        <CardContent className="p-5 flex flex-col gap-3">
          {/* Header: name + repo count */}
          <div className="flex items-start justify-between gap-2">
            <h3 className="text-sm font-semibold truncate">{project.name}</h3>
            {bootstrapTemplate && (
              <Badge
                variant="outline"
                className="text-[10px] shrink-0 gap-1 bg-purple-500/10 text-purple-400 border-purple-500/20"
              >
                <Sparkles className="h-2.5 w-2.5" />
                {bootstrapTemplate.name}
              </Badge>
            )}
            {repoCount > 0 && (
              <Badge
                variant="outline"
                className={`text-[10px] shrink-0 ${
                  readyCount === repoCount
                    ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/20"
                    : "bg-muted text-muted-foreground border-border"
                }`}
              >
                {repoCount} repo{repoCount !== 1 ? "s" : ""}
              </Badge>
            )}
          </div>

          {/* Description */}
          {project.description && (
            <p className="text-xs text-muted-foreground line-clamp-2 leading-relaxed">
              {project.description}
            </p>
          )}

          {/* Repo names preview */}
          {project.repositories.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {project.repositories.slice(0, 4).map((repo) => (
                <span
                  key={repo.id}
                  className="inline-flex items-center gap-1 text-[10px] text-muted-foreground bg-muted/50 rounded px-1.5 py-0.5"
                >
                  <FolderGit2 className="h-2.5 w-2.5" />
                  {repo.name}
                </span>
              ))}
              {project.repositories.length > 4 && (
                <span className="text-[10px] text-muted-foreground/60 px-1">
                  +{project.repositories.length - 4} more
                </span>
              )}
            </div>
          )}

          {/* Stats */}
          <div className="flex items-center gap-4 mt-auto pt-2">
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <GitFork className="h-3 w-3" />
              <span>{project._count.features}</span>
            </div>
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <MessageSquareCode className="h-3 w-3" />
              <span>{project._count.conversations}</span>
            </div>
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground ml-auto">
              <Clock className="h-3 w-3" />
              <span>
                {formatDistanceToNow(new Date(project.updatedAt), {
                  addSuffix: true,
                })}
              </span>
            </div>
          </div>
        </CardContent>
        <div className="absolute inset-x-0 bottom-0 h-px bg-gradient-to-r from-transparent via-foreground/5 to-transparent group-hover:via-foreground/10 transition-colors" />
      </Card>
    </Link>
  );
}
