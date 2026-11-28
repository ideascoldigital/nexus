"use client";

// Workspaces in Settings (spec 39): create, rename, delete and switch — what
// the switcher deliberately does not do. The old /workspaces page redirects
// to the bots view now, so this is where "Manage workspaces" lands.

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Boxes, Check, ChevronLeft, Pencil, Plus, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { WorkspaceAvatar, WorkspaceFields, type WorkspaceInfo } from "@/components/workspaces/workspace-editor-dialog";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";

async function fetchWorkspaces(): Promise<{ activeId: string; workspaces: WorkspaceInfo[] }> {
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
  window.location.href = "/bots";
}

export function WorkspacesSection({ startNew = false }: { startNew?: boolean }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  // The form is a page of its own here (back link, then the fields), like
  // the other drill-ins in Settings — not a modal over the list.
  const [form, setForm] = useState<null | { ws: WorkspaceInfo | null }>(startNew ? { ws: null } : null);
  const [deleting, setDeleting] = useState<WorkspaceInfo | null>(null);
  const { data, isLoading } = useQuery({ queryKey: ["workspaces"], queryFn: fetchWorkspaces });
  const refresh = () => qc.invalidateQueries({ queryKey: ["workspaces"] });

  const remove = async (w: WorkspaceInfo) => {
    const res = await fetch(`/api/workspaces/${w.id}`, { method: "DELETE" });
    if (res.ok) refresh();
    else {
      const body = await res.json().catch(() => ({}));
      toast({ title: "Could not delete the workspace", description: body.error, variant: "destructive" });
    }
  };

  if (form) {
    const ws = form.ws;
    return (
      <div className="space-y-5">
        <button
          type="button"
          onClick={() => setForm(null)}
          className="flex items-center gap-1 text-[12.5px] text-muted-foreground hover:text-foreground"
        >
          <ChevronLeft className="h-3.5 w-3.5" />
          Workspaces
        </button>
        <div className="flex items-center gap-3">
          {ws ? (
            <span className="flex h-12 w-12 shrink-0 items-center justify-center">
              <WorkspaceAvatar ws={ws} size="lg" />
            </span>
          ) : (
            <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl border border-border bg-card">
              <Boxes className="h-5 w-5 text-muted-foreground" />
            </span>
          )}
          <div className="min-w-0">
            <h3 className="text-[16px] font-semibold">{ws ? `Edit ${ws.name}` : "New workspace"}</h3>
            <p className="text-[12.5px] text-muted-foreground">
              {ws ? "Its name, icon and logo." : "Its own projects, bots, skills and settings. It becomes the active one."}
            </p>
          </div>
        </div>
        <div className="rounded-2xl border border-border bg-card/60 px-4 py-4">
          <WorkspaceFields
            key={ws?.id ?? "new"}
            workspace={ws}
            onCancel={() => setForm(null)}
            onSaved={async (id, created) => {
              // A new workspace becomes the active one; an edit goes back to the list.
              if (created) await activate(id);
              else {
                refresh();
                setForm(null);
              }
            }}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-4 px-1">
        <p className="text-[12.5px] text-muted-foreground">
          Each one has its own projects, bots, skills and settings. New ones use the default&apos;s tokens until they set their own.
        </p>
        {/* The same pill as the Vault's "New item". */}
        <button
          type="button"
          onClick={() => setForm({ ws: null })}
          className="flex h-9 shrink-0 items-center gap-1.5 rounded-full bg-foreground px-4 text-[13px] font-medium text-background transition-opacity hover:opacity-85"
        >
          <Plus className="h-3.5 w-3.5" />
          New workspace
        </button>
      </div>

      <div className="divide-y divide-border/60 overflow-hidden rounded-2xl border border-border bg-card/60">
        {isLoading && <p className="px-4 py-3 text-[12.5px] text-muted-foreground">Loading…</p>}
        {data?.workspaces.map((w) => {
          const active = w.id === data.activeId;
          const isDefault = w.id === "ws-default";
          const deletable = !isDefault && !active && w.projectCount === 0;
          return (
            <div key={w.id} className="group flex items-center gap-3 px-4 py-3">
              <WorkspaceAvatar ws={w} size="lg" />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate text-[13.5px] font-medium">{w.name}</span>
                  {active && (
                    <span className="flex shrink-0 items-center gap-1 rounded-full border border-emerald-500/20 bg-emerald-500/10 px-2 py-0.5 text-[10px] text-emerald-300">
                      <Check className="h-3 w-3" />
                      active
                    </span>
                  )}
                  {isDefault && (
                    <span className="shrink-0 rounded-full border border-border/60 px-2 py-0.5 text-[10px] text-muted-foreground">default</span>
                  )}
                </div>
                <p className="text-[12px] text-muted-foreground">
                  {w.projectCount} project{w.projectCount !== 1 ? "s" : ""}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                {!active && (
                  <Button size="sm" variant="outline" className="h-7 rounded-lg text-xs" onClick={() => void activate(w.id)}>
                    Switch to
                  </Button>
                )}
                <button
                  type="button"
                  onClick={() => setForm({ ws: w })}
                  aria-label={`Edit ${w.name}`}
                  title="Edit"
                  className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
                >
                  <Pencil className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  disabled={!deletable}
                  onClick={() => setDeleting(w)}
                  aria-label={`Delete ${w.name}`}
                  title={
                    deletable
                      ? "Delete"
                      : isDefault
                        ? "The default workspace stays"
                        : active
                          ? "Switch to another one first"
                          : "Move or delete its projects first"
                  }
                  className={cn(
                    "flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground",
                    deletable ? "hover:bg-accent hover:text-destructive" : "opacity-30",
                  )}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
          );
        })}
      </div>

      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={`Delete ${deleting?.name ?? "this workspace"}?`}
        description="The workspace and its settings go for good. It has no projects, so nothing else changes."
        confirmLabel="Delete workspace"
        onConfirm={() => {
          if (deleting) void remove(deleting);
          setDeleting(null);
        }}
      />
    </div>
  );
}
