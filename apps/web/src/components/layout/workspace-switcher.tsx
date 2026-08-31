"use client";

// Workspace switcher — sits at the top of the sidebar. A pure SELECTOR:
// pick a workspace, create one in a pinch, jump to /workspaces for anything
// else. Editing and deleting deliberately live on that page, not in a
// dropdown row where a mis-click next to "switch" used to rename things.

import { useState } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { Check, ChevronsUpDown, Settings2 } from "lucide-react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
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

export function WorkspaceSwitcher({ collapsed = false }: { collapsed?: boolean }) {
  const [creating, setCreating] = useState(false);

  const { data } = useQuery({
    queryKey: ["workspaces"],
    queryFn: fetchWorkspaces,
  });

  const active = data?.workspaces.find((w) => w.id === data.activeId);

  // Collapsed sidebar: same menu, icon-only trigger — the name lives in a
  // tooltip since there is no room for a label.
  const trigger = (
    <DropdownMenuTrigger
      className={
        collapsed
          ? "mx-auto mb-2 flex h-9 w-9 items-center justify-center rounded-lg border border-border/60 bg-background/40 transition-colors hover:border-border"
          : "mx-0.5 mb-2 flex items-center gap-2 rounded-lg border border-border/60 bg-background/40 px-2.5 py-2 text-left transition-colors hover:border-border"
      }
      aria-label="Switch workspace"
    >
      <WorkspaceAvatar ws={active} size="md" />
      {!collapsed && (
        <>
          <span className="min-w-0 flex-1 truncate text-[12.5px] font-semibold">
            {active?.name ?? "…"}
          </span>
          <ChevronsUpDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        </>
      )}
    </DropdownMenuTrigger>
  );

  return (
    <DropdownMenu>
      {collapsed ? (
        <Tooltip>
          <TooltipTrigger render={trigger} />
          <TooltipContent side="right">
            {active?.name ?? "Workspace"} · switch workspace
          </TooltipContent>
        </Tooltip>
      ) : (
        trigger
      )}
      <DropdownMenuContent align="start" className="w-56">
        {data?.workspaces.map((w) => (
          <DropdownMenuItem
            key={w.id}
            onClick={() => {
              if (w.id !== data.activeId) void activate(w.id);
            }}
            className="gap-2"
          >
            <WorkspaceAvatar ws={w} size="sm" />
            <span className="min-w-0 flex-1 truncate">{w.name}</span>
            <span className="font-mono text-[10px] text-muted-foreground">
              {w.projectCount}
            </span>
            {w.id === data.activeId && (
              <Check className="h-3.5 w-3.5 text-primary" />
            )}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        {/* Base UI menus close on item click — creation lives in a dialog. */}
        <DropdownMenuItem
          onClick={() => setCreating(true)}
          className="text-muted-foreground"
        >
          + New workspace
        </DropdownMenuItem>
        <DropdownMenuItem
          render={<Link href="/workspaces" />}
          className="gap-2 text-muted-foreground"
        >
          <Settings2 className="h-3.5 w-3.5" />
          Manage workspaces
        </DropdownMenuItem>
      </DropdownMenuContent>

      <WorkspaceEditorDialog
        open={creating}
        onOpenChange={setCreating}
        workspace={null}
        onSaved={async (id, created) => {
          if (created) await activate(id);
        }}
      />
    </DropdownMenu>
  );
}
