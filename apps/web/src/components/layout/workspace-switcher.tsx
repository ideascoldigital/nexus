"use client";

// Workspace switcher — the top of the dashboard sidebar, and the bots title
// bar (`variant="compact"`). A pure SELECTOR: pick a workspace, create one in
// a pinch, jump to /workspaces for anything else. Editing and deleting
// deliberately live on that page, not in a dropdown row where a mis-click
// next to "switch" used to rename things.

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

async function activate(id: string, returnTo: string) {
  await fetch("/api/workspaces/activate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id }),
  });
  // Full reload: server components, queries and cookies all re-scope.
  window.location.href = returnTo;
}

export function WorkspaceSwitcher({
  collapsed = false,
  /**
   * "compact" is the bots title bar: a round icon button the size of the ones
   * next to it, since that bar has no room for a name.
   */
  variant = "sidebar",
  /** Where the reload lands — the bots view switches without leaving itself. */
  returnTo = "/",
}: {
  collapsed?: boolean;
  variant?: "sidebar" | "compact";
  returnTo?: string;
}) {
  const [creating, setCreating] = useState(false);

  const { data } = useQuery({
    queryKey: ["workspaces"],
    queryFn: fetchWorkspaces,
  });

  const active = data?.workspaces.find((w) => w.id === data.activeId);
  const compact = variant === "compact";
  // No label: the name lives in a tooltip instead.
  const iconOnly = compact || collapsed;

  const trigger = (
    <DropdownMenuTrigger
      className={
        compact
          ? "flex size-7 shrink-0 items-center justify-center rounded-full bg-secondary text-secondary-foreground transition-colors hover:bg-secondary/80"
          : collapsed
            ? "mx-auto mb-2 flex h-9 w-9 items-center justify-center rounded-lg border border-border/60 bg-background/40 transition-colors hover:border-border"
            : "mx-0.5 mb-2 flex items-center gap-2 rounded-lg border border-border/60 bg-background/40 px-2.5 py-2 text-left transition-colors hover:border-border"
      }
      aria-label="Switch workspace"
    >
      <WorkspaceAvatar ws={active} size="md" />
      {!iconOnly && (
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
      {iconOnly ? (
        <Tooltip>
          <TooltipTrigger render={trigger} />
          <TooltipContent side={compact ? "bottom" : "right"}>
            {active?.name ?? "Workspace"} · switch workspace
          </TooltipContent>
        </Tooltip>
      ) : (
        trigger
      )}
      <DropdownMenuContent align={compact ? "end" : "start"} className="w-56">
        {data?.workspaces.map((w) => (
          <DropdownMenuItem
            key={w.id}
            onClick={() => {
              if (w.id !== data.activeId) void activate(w.id, returnTo);
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
          if (created) await activate(id, returnTo);
        }}
      />
    </DropdownMenu>
  );
}
