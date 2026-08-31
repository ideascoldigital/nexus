"use client";

import { useState } from "react";
import {
  Plus,
  Cloud,
  FolderOpen,
  FolderTree,
  FolderUp,
  Folder,
  Terminal as TerminalIcon,
  SquareTerminal,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export type PickerEntry = {
  id: string;
  label: string;
  cwd: string;
  hint?: string;
};

/**
 * A shell this machine can run, as reported by `/api/terminal/shells`. Declared
 * here rather than imported from `@nexux/terminal`: that module enumerates WSL
 * with `child_process` and must never reach the client bundle.
 */
export type ShellOption = {
  id: string;
  label: string;
  kind: string;
  distro?: string;
};

/**
 * Remote sessions choose their own shell — ssh runs the login shell on the box,
 * docker runs bash in the container — so offering a local shell for them would
 * be a lie. Only local directories get the submenu.
 */
function isRemoteEntry(entry: PickerEntry): boolean {
  return /^(ssh|docker):\/\//.test(entry.cwd);
}

interface TerminalPickerProps {
  entries: PickerEntry[];
  onPick: (cwd: string, label: string, shellId?: string) => void;
  /** Empty or single-entry means "one shell here" — the submenu is skipped. */
  shells?: ShellOption[];
  defaultShellId?: string;
  triggerLabel?: string;
}

function parentDir(p: string): string {
  const trimmed = p.replace(/\/+$/, "");
  const idx = trimmed.lastIndexOf("/");
  if (idx <= 0) return "/";
  return trimmed.slice(0, idx);
}

export function buildPickerEntries(
  repositories: Array<{
    id: string;
    name: string;
    localPath: string | null;
    isMain: boolean;
  }>,
  workspacePath: string | null
): PickerEntry[] {
  const out: PickerEntry[] = [];
  const seenCwd = new Set<string>();

  const reposWithPath = repositories.filter((r) => r.localPath);

  for (const r of reposWithPath) {
    const cwd = r.localPath as string;
    if (seenCwd.has(cwd)) continue;
    seenCwd.add(cwd);
    out.push({
      id: `repo:${r.id}`,
      label: r.name + (r.isMain ? " (main)" : ""),
      cwd,
      hint: cwd,
    });
  }

  for (const r of reposWithPath) {
    const parent = parentDir(r.localPath as string);
    if (seenCwd.has(parent)) continue;
    seenCwd.add(parent);
    out.push({
      id: `parent:${r.id}`,
      label: `${r.name} · parent`,
      cwd: parent,
      hint: parent,
    });
  }

  if (workspacePath && !seenCwd.has(workspacePath)) {
    seenCwd.add(workspacePath);
    out.push({
      id: "workspace",
      label: "Workspace root",
      cwd: workspacePath,
      hint: workspacePath,
    });
  }

  return out;
}

function EntryIcon({ entry }: { entry: PickerEntry }) {
  if (entry.id.startsWith("sandbox:"))
    return <Cloud className="h-3.5 w-3.5 text-orange-400" />;
  if (entry.id.startsWith("parent:")) return <FolderUp className="h-3.5 w-3.5" />;
  if (entry.id === "workspace") return <FolderTree className="h-3.5 w-3.5" />;
  return <FolderOpen className="h-3.5 w-3.5" />;
}

function ShellIcon({ shell }: { shell: ShellOption }) {
  return shell.kind === "wsl" ? (
    <SquareTerminal className="h-3.5 w-3.5 text-sky-400" />
  ) : (
    <TerminalIcon className="h-3.5 w-3.5" />
  );
}

interface TerminalPickerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  entries: PickerEntry[];
  onPick: (cwd: string, label: string, shellId?: string) => void;
  shells?: ShellOption[];
  defaultShellId?: string;
  title?: string;
  description?: string;
}

export function TerminalPickerDialog({
  open,
  onOpenChange,
  entries,
  onPick,
  shells = [],
  defaultShellId,
  title = "Open terminal in…",
  description = "Pick a project directory or enter a custom path.",
}: TerminalPickerDialogProps) {
  const [customPath, setCustomPath] = useState("");
  const [customMode, setCustomMode] = useState(false);
  // Which directory's shell list is expanded. The dialog has no submenus, so
  // picking a directory reveals its shells inline instead.
  const [shellFor, setShellFor] = useState<PickerEntry | null>(null);
  const multiShell = shells.length > 1;

  function handlePick(cwd: string, label: string, shellId?: string) {
    onPick(cwd, label, shellId);
    onOpenChange(false);
    setCustomMode(false);
    setCustomPath("");
    setShellFor(null);
  }

  function pickCustom(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = customPath.trim();
    if (!trimmed) return;
    handlePick(trimmed, trimmed);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        {shellFor ? (
          <div className="flex flex-col gap-1 py-2 max-h-80 overflow-y-auto">
            <p className="px-2 pb-1 text-xs text-muted-foreground">
              Shell for <span className="font-medium">{shellFor.label}</span>
            </p>
            {shells.map((shell) => (
              <button
                key={shell.id}
                type="button"
                onClick={() =>
                  handlePick(
                    shellFor.cwd,
                    `${shellFor.label} · ${shell.label}`,
                    shell.id,
                  )
                }
                className="flex items-center gap-2 rounded-md px-2 py-2 text-left hover:bg-accent"
              >
                <ShellIcon shell={shell} />
                <span className="text-sm">{shell.label}</span>
                {shell.id === defaultShellId && (
                  <span className="ml-auto text-[10px] text-muted-foreground">
                    default
                  </span>
                )}
              </button>
            ))}
            <button
              type="button"
              onClick={() => setShellFor(null)}
              className="mt-1 border-t border-border/40 px-2 pt-3 text-left text-sm hover:bg-accent"
            >
              Back
            </button>
          </div>
        ) : !customMode ? (
          <div className="flex flex-col gap-1 py-2 max-h-80 overflow-y-auto">
            {entries.length === 0 && (
              <p className="text-xs text-muted-foreground px-2 py-3">
                No repos available
              </p>
            )}
            {entries.map((entry) => (
              <button
                key={entry.id}
                type="button"
                onClick={() =>
                  multiShell && !isRemoteEntry(entry)
                    ? setShellFor(entry)
                    : handlePick(entry.cwd, entry.label)
                }
                className="flex flex-col items-start gap-0.5 rounded-md px-2 py-2 text-left hover:bg-accent"
              >
                <div className="flex items-center gap-2">
                  <EntryIcon entry={entry} />
                  <span className="text-sm">{entry.label}</span>
                </div>
                {entry.hint && (
                  <span className="text-[10px] text-muted-foreground pl-5 truncate max-w-[320px]">
                    {entry.hint}
                  </span>
                )}
              </button>
            ))}
            <button
              type="button"
              onClick={() => setCustomMode(true)}
              className="flex items-center gap-2 rounded-md px-2 py-2 text-left hover:bg-accent mt-1 border-t border-border/40 pt-3"
            >
              <Folder className="h-3.5 w-3.5" />
              <span className="text-sm">Other path…</span>
            </button>
          </div>
        ) : (
          <form onSubmit={pickCustom}>
            <div className="grid gap-2 py-4">
              <Label htmlFor="custom-path-dialog">Path</Label>
              <Input
                id="custom-path-dialog"
                value={customPath}
                onChange={(e) => setCustomPath(e.target.value)}
                placeholder="/Users/you/some/dir"
                autoFocus
                required
              />
            </div>
            <DialogFooter className="gap-2">
              <Button
                type="button"
                variant="ghost"
                onClick={() => setCustomMode(false)}
              >
                Back
              </Button>
              <Button type="submit" disabled={!customPath.trim()}>
                Open
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

export function TerminalPicker({
  entries,
  onPick,
  shells = [],
  defaultShellId,
  triggerLabel = "New",
}: TerminalPickerProps) {
  const [customOpen, setCustomOpen] = useState(false);
  const [customPath, setCustomPath] = useState("");
  const [customShellId, setCustomShellId] = useState<string | undefined>();
  const multiShell = shells.length > 1;

  function pickCustom(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = customPath.trim();
    if (!trimmed) return;
    onPick(trimmed, trimmed, customShellId);
    setCustomOpen(false);
    setCustomPath("");
    setCustomShellId(undefined);
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button variant="outline" size="sm" className="gap-1.5 h-7">
              <Plus className="h-3.5 w-3.5" />
              {triggerLabel}
            </Button>
          }
        />
        <DropdownMenuContent align="start" className="min-w-56">
          <DropdownMenuGroup>
            <DropdownMenuLabel>Open terminal in…</DropdownMenuLabel>
            <DropdownMenuSeparator />
            {entries.length === 0 && (
              <DropdownMenuItem disabled>No repos available</DropdownMenuItem>
            )}
            {entries.map((entry) => {
              const body = (
                <>
                  <div className="flex items-center gap-2">
                    <EntryIcon entry={entry} />
                    <span className="text-sm">{entry.label}</span>
                  </div>
                  {entry.hint && (
                    <span className="text-[10px] text-muted-foreground pl-5 truncate max-w-[280px]">
                      {entry.hint}
                    </span>
                  )}
                </>
              );

              if (!multiShell || isRemoteEntry(entry)) {
                return (
                  <DropdownMenuItem
                    key={entry.id}
                    onClick={() => onPick(entry.cwd, entry.label)}
                    className="flex flex-col items-start gap-0.5"
                  >
                    {body}
                  </DropdownMenuItem>
                );
              }

              return (
                <DropdownMenuSub key={entry.id}>
                  <DropdownMenuSubTrigger className="flex flex-col items-start gap-0.5">
                    {body}
                  </DropdownMenuSubTrigger>
                  <DropdownMenuSubContent className="min-w-48">
                    {shells.map((shell) => (
                      <DropdownMenuItem
                        key={shell.id}
                        onClick={() =>
                          onPick(
                            entry.cwd,
                            `${entry.label} · ${shell.label}`,
                            shell.id,
                          )
                        }
                        className="gap-2"
                      >
                        <ShellIcon shell={shell} />
                        <span className="text-sm">{shell.label}</span>
                        {shell.id === defaultShellId && (
                          <span className="ml-auto text-[10px] text-muted-foreground">
                            default
                          </span>
                        )}
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuSubContent>
                </DropdownMenuSub>
              );
            })}
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onClick={() => setCustomOpen(true)}
              className="gap-2"
            >
              <Folder className="h-3.5 w-3.5" />
              <span className="text-sm">Other path…</span>
            </DropdownMenuItem>
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog open={customOpen} onOpenChange={setCustomOpen}>
        <DialogContent className="sm:max-w-md">
          <form onSubmit={pickCustom}>
            <DialogHeader>
              <DialogTitle>Open terminal in path</DialogTitle>
              <DialogDescription>
                Enter an absolute path on this machine.
              </DialogDescription>
            </DialogHeader>
            <div className="grid gap-2 py-4">
              <Label htmlFor="custom-path">Path</Label>
              <Input
                id="custom-path"
                value={customPath}
                onChange={(e) => setCustomPath(e.target.value)}
                placeholder={
                  multiShell ? "E:\\workspace\\proj or /home/you/proj" : "/Users/you/some/dir"
                }
                autoFocus
                required
              />
              {multiShell && (
                <>
                  <Label htmlFor="custom-shell" className="mt-2">
                    Shell
                  </Label>
                  <select
                    id="custom-shell"
                    value={customShellId ?? ""}
                    onChange={(e) =>
                      setCustomShellId(e.target.value || undefined)
                    }
                    className="h-9 rounded-md border border-input bg-transparent px-3 text-sm"
                  >
                    <option value="">Default</option>
                    {shells.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.label}
                      </option>
                    ))}
                  </select>
                  <p className="text-[11px] text-muted-foreground">
                    A WSL shell reads the path from inside the distro — a
                    Windows path is translated (E:\… → /mnt/e/…).
                  </p>
                </>
              )}
            </div>
            <DialogFooter>
              <Button type="submit" disabled={!customPath.trim()}>
                Open
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
