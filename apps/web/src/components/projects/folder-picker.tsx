"use client";

import { useState, useEffect, useCallback } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogClose,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Folder,
  FolderGit2,
  ChevronUp,
  Loader2,
  CornerDownLeft,
} from "lucide-react";
import { cn } from "@/lib/utils";

interface DirEntry {
  name: string;
  path: string;
  isGitRepo: boolean;
}

interface BrowseResult {
  current: string;
  parent: string;
  dirs: DirEntry[];
}

interface FolderPickerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (path: string) => void;
  initialPath?: string;
}

export function FolderPicker({
  open,
  onOpenChange,
  onSelect,
  initialPath,
}: FolderPickerProps) {
  const [currentPath, setCurrentPath] = useState(initialPath || "~");
  const [pathInput, setPathInput] = useState(initialPath || "~");
  const [data, setData] = useState<BrowseResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const browse = useCallback(async (dir: string) => {
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/browse-directory", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ directory: dir }),
      });
      const result = await res.json();
      if (!res.ok) {
        setError(result.error || "Failed to browse");
        return;
      }
      setData(result);
      setCurrentPath(result.current);
      setPathInput(result.current);
    } catch {
      setError("Failed to browse directory");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open) {
      browse(initialPath || "~");
    }
  }, [open, initialPath, browse]);

  function handleNavigate(dir: string) {
    browse(dir);
  }

  function handlePathSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (pathInput.trim()) browse(pathInput.trim());
  }

  function handleSelect() {
    onSelect(currentPath);
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Select Folder</DialogTitle>
        </DialogHeader>

        {/* Path input with navigation */}
        <form onSubmit={handlePathSubmit} className="flex gap-2">
          <Input
            value={pathInput}
            onChange={(e) => setPathInput(e.target.value)}
            className="h-8 text-xs font-mono flex-1"
            placeholder="/path/to/folder"
          />
          <Button type="submit" variant="outline" size="icon-sm">
            <CornerDownLeft className="h-3.5 w-3.5" />
          </Button>
        </form>

        {error && <p className="text-xs text-destructive">{error}</p>}

        {/* Directory listing */}
        <ScrollArea className="h-[300px] -mx-1 px-1">
          {loading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
            </div>
          ) : data ? (
            <div className="space-y-0.5">
              {/* Go up */}
              {data.current !== data.parent && (
                <button
                  type="button"
                  onClick={() => handleNavigate(data.parent)}
                  className="w-full flex items-center gap-2.5 rounded-md px-2.5 py-2 text-left hover:bg-muted/50 transition-colors"
                >
                  <ChevronUp className="h-3.5 w-3.5 text-muted-foreground" />
                  <span className="text-xs text-muted-foreground">..</span>
                </button>
              )}

              {data.dirs.length === 0 && (
                <p className="text-xs text-muted-foreground/60 text-center py-8">
                  No subdirectories
                </p>
              )}

              {data.dirs.map((dir) => (
                <button
                  key={dir.path}
                  type="button"
                  onDoubleClick={() => handleNavigate(dir.path)}
                  onClick={() => {
                    setCurrentPath(dir.path);
                    setPathInput(dir.path);
                  }}
                  className={cn(
                    "w-full flex items-center gap-2.5 rounded-md px-2.5 py-2 text-left transition-colors",
                    currentPath === dir.path
                      ? "bg-primary/10 ring-1 ring-primary/20"
                      : "hover:bg-muted/50"
                  )}
                >
                  {dir.isGitRepo ? (
                    <FolderGit2 className="h-3.5 w-3.5 text-emerald-400 shrink-0" />
                  ) : (
                    <Folder className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                  )}
                  <span className="text-xs truncate">{dir.name}</span>
                  {dir.isGitRepo && (
                    <span className="ml-auto text-[9px] text-emerald-400/60 shrink-0">
                      git
                    </span>
                  )}
                </button>
              ))}
            </div>
          ) : null}
        </ScrollArea>

        <div className="flex items-center gap-2 pt-1 border-t border-border/50">
          <code className="text-[10px] text-muted-foreground font-mono truncate flex-1">
            {currentPath}
          </code>
        </div>

        <DialogFooter>
          <DialogClose render={<Button variant="ghost" size="sm" />}>
            Cancel
          </DialogClose>
          <Button size="sm" onClick={handleSelect}>
            Select this folder
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
