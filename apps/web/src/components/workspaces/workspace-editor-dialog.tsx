"use client";

// The one workspace editor: create and edit share this dialog, used by the
// /workspaces page (management home) and by the sidebar switcher's "+ New
// workspace" (which stays a shortcut — management lives on the page).

import { useRef, useState } from "react";
import { ImagePlus, Loader2 } from "lucide-react";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export type WorkspaceInfo = {
  id: string;
  name: string;
  icon: string | null;
  logo: string | null;
  projectCount: number;
};

/** logo > emoji > first letter. */
export function WorkspaceAvatar({
  ws,
  size,
}: {
  ws: { name: string; icon: string | null; logo: string | null } | undefined;
  size: "sm" | "md" | "lg";
}) {
  const cls =
    size === "lg" ? "h-9 w-9 text-sm" : size === "md" ? "h-5 w-5" : "h-4 w-4";
  if (ws?.logo) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={ws.logo}
        alt=""
        className={`${cls} shrink-0 rounded object-cover`}
      />
    );
  }
  return (
    <span
      className={`flex ${cls} shrink-0 items-center justify-center rounded bg-primary/20 font-mono text-[10px] font-bold text-primary`}
    >
      {ws?.icon ?? (ws?.name ?? "P").slice(0, 1).toUpperCase()}
    </span>
  );
}

/** Downscale any picked image to a 64px square PNG data URL — stays tiny. */
function fileToLogo(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = 64;
      canvas.height = 64;
      const ctx = canvas.getContext("2d")!;
      const side = Math.min(img.width, img.height);
      ctx.drawImage(
        img,
        (img.width - side) / 2,
        (img.height - side) / 2,
        side,
        side,
        0,
        0,
        64,
        64,
      );
      URL.revokeObjectURL(url);
      resolve(canvas.toDataURL("image/png"));
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Could not read the image"));
    };
    img.src = url;
  });
}

const ICON_PRESETS = ["🏠", "🚀", "💼", "🧪", "🛰️", "🎯", "🧩", "🐙", "⚡", "🌙", "🔥", "🌊"];

export function WorkspaceEditorDialog({
  open,
  onOpenChange,
  workspace,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Null = create a new workspace. */
  workspace: WorkspaceInfo | null;
  /** Receives the saved workspace's id (fresh from POST for creations). */
  onSaved: (id: string, created: boolean) => void | Promise<void>;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* Keyed remount: each open (and each subject) starts from the
          workspace's current values — no state-syncing effect needed. */}
      {open && (
        <EditorForm
          key={workspace?.id ?? "new"}
          workspace={workspace}
          onOpenChange={onOpenChange}
          onSaved={onSaved}
        />
      )}
    </Dialog>
  );
}

function EditorForm({
  workspace,
  onOpenChange,
  onSaved,
}: {
  workspace: WorkspaceInfo | null;
  onOpenChange: (open: boolean) => void;
  onSaved: (id: string, created: boolean) => void | Promise<void>;
}) {
  const [name, setName] = useState(workspace?.name ?? "");
  const [icon, setIcon] = useState(workspace?.icon ?? "");
  const [logo, setLogo] = useState<string | null>(workspace?.logo ?? null);
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const pickLogo = async (file: File | undefined | null) => {
    if (!file || !file.type.startsWith("image/")) return;
    try {
      setLogo(await fileToLogo(file));
    } catch {
      // unreadable image — keep whatever was there
    }
  };

  const submit = async () => {
    const trimmed = name.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    try {
      if (workspace) {
        const res = await fetch(`/api/workspaces/${workspace.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: trimmed,
            icon: icon.trim() || null,
            logo,
          }),
        });
        if (res.ok) {
          onOpenChange(false);
          await onSaved(workspace.id, false);
        }
      } else {
        const res = await fetch("/api/workspaces", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: trimmed,
            icon: icon.trim() || undefined,
            logo: logo ?? undefined,
          }),
        });
        if (res.ok) {
          const ws = (await res.json()) as { id: string };
          onOpenChange(false);
          await onSaved(ws.id, true);
        }
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>
            {workspace ? "Edit workspace" : "New workspace"}
          </DialogTitle>
          <DialogDescription>
            {workspace
              ? "Rename it or pick a different icon."
              : "An isolated space: its own projects, agents, skills, credentials and settings (it inherits Personal's tokens until it defines its own)."}
          </DialogDescription>
        </DialogHeader>
        <div className="flex items-center gap-2">
          <Input
            value={icon}
            onChange={(e) => setIcon(e.target.value)}
            placeholder="🙂"
            maxLength={4}
            className="w-14 text-center text-lg"
            aria-label="Workspace icon"
          />
          <Input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void submit();
            }}
            placeholder="e.g. Cliente ACME"
            className="flex-1 text-sm"
          />
        </div>
        {/* Logo dropzone — click to browse or drag an image in. */}
        <div
          role="button"
          tabIndex={0}
          onClick={() => fileRef.current?.click()}
          onKeyDown={(e) => {
            if (e.key === "Enter") fileRef.current?.click();
          }}
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            void pickLogo(e.dataTransfer.files?.[0]);
          }}
          className={`flex cursor-pointer items-center gap-3 rounded-lg border border-dashed px-3 py-3 transition-colors ${
            dragging
              ? "border-primary bg-primary/10"
              : "border-border/70 hover:border-border"
          }`}
        >
          {logo ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={logo}
              alt="Workspace logo"
              className="h-10 w-10 shrink-0 rounded-md object-cover"
            />
          ) : (
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-muted/40">
              <ImagePlus className="h-4 w-4 text-muted-foreground" />
            </span>
          )}
          <span className="min-w-0 flex-1 text-[11px] text-muted-foreground">
            {logo
              ? "Click or drop an image to replace the logo"
              : "Drop your logo here, or click to browse"}
          </span>
          {logo && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setLogo(null);
              }}
              className="shrink-0 text-[11px] text-muted-foreground underline-offset-2 hover:text-destructive hover:underline"
            >
              Remove
            </button>
          )}
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(e) => {
              void pickLogo(e.target.files?.[0]);
              e.target.value = "";
            }}
          />
        </div>
        <div className="flex flex-wrap gap-1">
          {ICON_PRESETS.map((emoji) => (
            <button
              key={emoji}
              type="button"
              onClick={() => setIcon(emoji)}
              className={`flex h-7 w-7 items-center justify-center rounded-md text-base transition-colors hover:bg-accent ${
                icon === emoji ? "bg-accent ring-1 ring-primary/50" : ""
              }`}
            >
              {emoji}
            </button>
          ))}
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={busy}
          >
            Cancel
          </Button>
          <Button
            onClick={() => void submit()}
            disabled={!name.trim() || busy}
            className="gap-1.5"
          >
            {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            {workspace ? "Save" : "Create"}
          </Button>
      </DialogFooter>
    </DialogContent>
  );
}
