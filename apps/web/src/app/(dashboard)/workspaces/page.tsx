"use client";

// Workspace management home: create, edit, delete and switch — everything the
// sidebar switcher deliberately does NOT do anymore. Each card is one
// isolated space; the active one wears the emerald hairline.

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Boxes, Check, Pencil, Plus, Trash2 } from "lucide-react";

import { AppHeader } from "@/components/layout/app-header";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  WorkspaceAvatar,
  WorkspaceEditorDialog,
  type WorkspaceInfo,
} from "@/components/workspaces/workspace-editor-dialog";

async function fetchWorkspaces(): Promise<{
  activeId: string;
  workspaces: WorkspaceInfo[];
}> {
  const res = await fetch("/api/workspaces");
  if (!res.ok) throw new Error("Failed to load workspaces");
  return res.json();
}

async function activate(id: string) {
  await fetch("/api/workspaces/activate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id }),
  });
  // Full reload: server components, queries and cookies all re-scope.
  window.location.href = "/";
}

export default function WorkspacesPage() {
  const qc = useQueryClient();
  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<WorkspaceInfo | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<WorkspaceInfo | null>(null);

  const { data } = useQuery({
    queryKey: ["workspaces"],
    queryFn: fetchWorkspaces,
  });

  const refresh = () => qc.invalidateQueries({ queryKey: ["workspaces"] });

  const remove = async (id: string) => {
    const res = await fetch(`/api/workspaces/${id}`, { method: "DELETE" });
    if (res.ok) refresh();
    setDeleteTarget(null);
  };

  const openCreate = () => {
    setEditing(null);
    setEditorOpen(true);
  };
  const openEdit = (w: WorkspaceInfo) => {
    setEditing(w);
    setEditorOpen(true);
  };

  return (
    <>
      <AppHeader title="Workspaces" />
      <div className="flex-1 overflow-auto">
        <div className="mx-auto w-full max-w-page space-y-5 px-4 py-6">
          {/* ---- Hero ---------------------------------------------------- */}
          <header className="flex flex-wrap items-start justify-between gap-4 border-b border-border/60 pb-5">
            <div className="flex items-start gap-3">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-primary/20 bg-primary/10 text-primary">
                <Boxes className="h-4.5 w-4.5" />
              </div>
              <div>
                <h1 className="text-base leading-tight font-semibold">
                  Workspaces
                </h1>
                <p className="mt-0.5 text-sm text-muted-foreground">
                  Isolated spaces — each with its own projects, agents, skills,
                  credentials and settings. Non-default ones inherit
                  Personal&apos;s tokens until they define their own.
                </p>
              </div>
            </div>
            <Button size="sm" className="gap-1.5" onClick={openCreate}>
              <Plus className="h-3.5 w-3.5" />
              New workspace
            </Button>
          </header>

          {/* ---- Grid ---------------------------------------------------- */}
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
            {data?.workspaces.map((w, i) => {
              const isActive = w.id === data.activeId;
              const deletable = w.id !== "ws-default" && w.projectCount === 0;
              return (
                <div
                  key={w.id}
                  className={cn(
                    "group animate-in fade-in slide-in-from-bottom-2 fill-mode-backwards relative overflow-hidden rounded-xl border bg-card p-5 duration-300",
                    isActive ? "border-emerald-500/30" : "border-border/50",
                  )}
                  style={{ animationDelay: `${Math.min(i * 35, 350)}ms` }}
                >
                  <span
                    className={cn(
                      "absolute top-4 bottom-4 left-0 w-0.5 rounded-full",
                      isActive ? "bg-emerald-400" : "bg-muted-foreground/30",
                    )}
                  />
                  <div className="flex items-start gap-3">
                    <WorkspaceAvatar ws={w} size="lg" />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <h3 className="truncate text-sm font-semibold">
                          {w.name}
                        </h3>
                        {isActive && (
                          <span className="flex shrink-0 items-center gap-1 rounded-full border border-emerald-500/20 bg-emerald-500/10 px-2 py-0.5 text-[10px] text-emerald-300">
                            <Check className="h-3 w-3" />
                            active
                          </span>
                        )}
                        {w.id === "ws-default" && (
                          <span className="shrink-0 rounded-full border border-border/60 px-2 py-0.5 text-[10px] text-muted-foreground">
                            default
                          </span>
                        )}
                      </div>
                      <p className="mt-0.5 font-mono text-[11px] text-muted-foreground">
                        {w.projectCount} project
                        {w.projectCount !== 1 ? "s" : ""}
                      </p>
                    </div>
                  </div>

                  <div className="mt-4 flex items-center gap-2 border-t border-border/40 pt-3">
                    {!isActive && (
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 text-xs"
                        onClick={() => void activate(w.id)}
                      >
                        Switch to
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 gap-1 text-xs text-muted-foreground"
                      onClick={() => openEdit(w)}
                    >
                      <Pencil className="h-3 w-3" />
                      Edit
                    </Button>
                    {deletable && (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="ml-auto h-7 gap-1 text-xs text-muted-foreground hover:text-destructive"
                        onClick={() => setDeleteTarget(w)}
                      >
                        <Trash2 className="h-3 w-3" />
                        Delete
                      </Button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      <WorkspaceEditorDialog
        open={editorOpen}
        onOpenChange={setEditorOpen}
        workspace={editing}
        onSaved={async (id, created) => {
          // A created workspace becomes the active one — same behaviour the
          // switcher always had; editing just refreshes in place.
          if (created) await activate(id);
          else refresh();
        }}
      />

      <AlertDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete “{deleteTarget?.name}”?</AlertDialogTitle>
            <AlertDialogDescription>
              The workspace and its settings are removed permanently. It has no
              projects, so nothing else is affected — but this cannot be
              undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (deleteTarget) void remove(deleteTarget.id);
              }}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Delete workspace
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
