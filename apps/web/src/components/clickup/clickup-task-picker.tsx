"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Check,
  CheckSquare,
  ChevronsUpDown,
  CircleCheck,
  CircleDot,
  ExternalLink,
  Loader2,
  RefreshCw,
  Search,
  X,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";

export interface ClickUpAccount {
  id: string;
  label: string;
  status: string;
  metadata: {
    username: string;
    /** Snapshot from the last connect/revalidate — a label, not the picker's
     * source of truth. The workspace dropdown reads /teams live (D-54). */
    teams: { id: string; name: string }[];
  } | null;
}

export interface ClickUpTeam {
  id: string;
  name: string;
}

export interface ClickUpSpace {
  id: string;
  name: string;
}

export interface ClickUpListSummary {
  id: string;
  name: string;
  folderName: string | null;
  taskCount: number | null;
}

export interface CachedClickUpTask {
  id: string;
  taskId: string;
  name: string;
  description: string | null;
  status: string | null;
  statusType: string | null;
  priority: string | null;
  url: string;
  tags: string[] | null;
  listName: string | null;
  parentTaskId: string | null;
  dueDate: string | null;
}

interface LinkedTask {
  id: string;
  task: CachedClickUpTask;
}

interface TaskPickerProps {
  projectId: string;
  featureId: string;
}

export function TaskStateIcon({ statusType }: { statusType: string | null }) {
  return statusType === "done" || statusType === "closed" ? (
    <CircleCheck className="h-3.5 w-3.5 text-purple-500 shrink-0" />
  ) : (
    <CircleDot className="h-3.5 w-3.5 text-green-500 shrink-0" />
  );
}

export function LinkedClickUpTasksList({ projectId, featureId }: TaskPickerProps) {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const { data: linked = [], isLoading } = useQuery<LinkedTask[]>({
    queryKey: ["feature-clickup-tasks", featureId],
    queryFn: async () => {
      const res = await fetch(
        `/api/projects/${projectId}/features/${featureId}/clickup-tasks`
      );
      if (!res.ok) throw new Error("Failed to load linked ClickUp tasks");
      return res.json();
    },
  });

  const unlinkMutation = useMutation({
    mutationFn: async (taskId: string) => {
      const res = await fetch(
        `/api/projects/${projectId}/features/${featureId}/clickup-tasks?taskId=${taskId}`,
        { method: "DELETE" }
      );
      if (!res.ok) throw new Error("Failed to unlink task");
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ["feature-clickup-tasks", featureId],
      });
    },
    onError: (err: Error) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  if (isLoading) return null;
  if (linked.length === 0) return null;

  return (
    <div className="space-y-1.5">
      {linked.map(({ id, task }) => (
        <div
          key={id}
          className="flex items-start gap-2 text-sm group rounded-md px-2 py-1.5 hover:bg-muted/50"
        >
          <TaskStateIcon statusType={task.statusType} />
          <div className="flex-1 min-w-0">
            <a
              href={task.url}
              target="_blank"
              rel="noopener noreferrer"
              className="font-medium hover:underline line-clamp-1 text-foreground"
            >
              {task.name}
            </a>
            <div className="flex items-center gap-1.5 mt-0.5 flex-wrap">
              {task.status && (
                <span className="text-xs text-muted-foreground">{task.status}</span>
              )}
              {task.listName && (
                <Badge variant="outline" className="text-xs py-0">
                  {task.listName}
                </Badge>
              )}
            </div>
          </div>
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6 opacity-0 group-hover:opacity-100 shrink-0"
            onClick={() => unlinkMutation.mutate(task.id)}
            disabled={unlinkMutation.isPending}
            title="Unlink task"
          >
            <X className="h-3.5 w-3.5" />
          </Button>
        </div>
      ))}
    </div>
  );
}

/**
 * Shared cascading selector: account → workspace → space → list, with a
 * manual sync button. Used by both the link picker and the import dialog.
 */
export function useClickUpBrowser(enabled: boolean) {
  const [accountId, setAccountId] = useState("");
  const [teamId, setTeamId] = useState("");
  const [spaceId, setSpaceId] = useState("");
  const [listId, setListId] = useState("");
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data: accounts = [] } = useQuery<ClickUpAccount[]>({
    queryKey: ["clickup-accounts"],
    queryFn: async () => {
      const res = await fetch("/api/clickup/accounts");
      if (!res.ok) throw new Error("Failed to load ClickUp accounts");
      return res.json();
    },
    enabled,
  });

  // Live, not `metadata.teams`: that snapshot is written once at connect time
  // and a single failed /team there left it `[]` forever, which renders as an
  // empty dropdown indistinguishable from an account with no workspaces.
  const { data: teams = [], isLoading: teamsLoading } = useQuery<ClickUpTeam[]>({
    queryKey: ["clickup-teams", accountId],
    queryFn: async () => {
      const res = await fetch(`/api/clickup/accounts/${accountId}/teams`);
      if (!res.ok) throw new Error("Failed to load workspaces");
      return res.json();
    },
    enabled: enabled && !!accountId,
  });

  const { data: spaces = [], isLoading: spacesLoading } = useQuery<ClickUpSpace[]>({
    queryKey: ["clickup-spaces", accountId, teamId],
    queryFn: async () => {
      const res = await fetch(
        `/api/clickup/accounts/${accountId}/spaces?teamId=${teamId}`
      );
      if (!res.ok) throw new Error("Failed to load spaces");
      return res.json();
    },
    enabled: !!accountId && !!teamId,
  });

  const { data: lists = [], isLoading: listsLoading } = useQuery<ClickUpListSummary[]>({
    queryKey: ["clickup-lists", accountId, spaceId],
    queryFn: async () => {
      const res = await fetch(
        `/api/clickup/accounts/${accountId}/lists?spaceId=${spaceId}`
      );
      if (!res.ok) throw new Error("Failed to load lists");
      return res.json();
    },
    enabled: !!accountId && !!spaceId,
  });

  const syncMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/clickup/accounts/${accountId}/sync`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ teamId, listId }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Sync failed");
      }
      return res.json() as Promise<{ synced: number }>;
    },
    onSuccess: (data) => {
      toast({ title: `Synced ${data.synced} tasks from ClickUp` });
      queryClient.invalidateQueries({ queryKey: ["clickup-tasks", accountId, listId] });
    },
    onError: (err: Error) => {
      toast({ title: "Sync failed", description: err.message, variant: "destructive" });
    },
  });

  return {
    accounts,
    teams,
    teamsLoading,
    spaces,
    spacesLoading,
    lists,
    listsLoading,
    accountId,
    teamId,
    spaceId,
    listId,
    syncMutation,
    setAccount: (id: string) => {
      setAccountId(id);
      setTeamId("");
      setSpaceId("");
      setListId("");
    },
    setTeam: (id: string) => {
      setTeamId(id);
      setSpaceId("");
      setListId("");
    },
    setSpace: (id: string) => {
      setSpaceId(id);
      setListId("");
    },
    setList: setListId,
  };
}

/** Folder-qualified, because list names repeat across folders. */
const listLabel = (l: ClickUpListSummary) =>
  l.folderName ? `${l.folderName} / ${l.name}` : l.name;

export function ClickUpBrowserSelects({
  browser,
}: {
  browser: ReturnType<typeof useClickUpBrowser>;
}) {
  const [listPickerOpen, setListPickerOpen] = useState(false);
  const selectedList = browser.lists.find((l) => l.id === browser.listId);

  // base-ui's Select.Value renders the raw value (an id) unless told how to
  // resolve a label — every select here displays through one of these.
  const label =
    <T,>(items: T[], id: (i: T) => string, name: (i: T) => string) =>
    (value: unknown) => {
      const item = items.find((i) => id(i) === value);
      return item ? name(item) : String(value ?? "");
    };

  return (
    <div className="flex gap-2 flex-wrap">
      <Select value={browser.accountId} onValueChange={(v) => browser.setAccount(v ?? "")}>
        <SelectTrigger className="min-w-40 max-w-56">
          <SelectValue placeholder="Account">
            {label(browser.accounts, (a) => a.id, (a) => a.label)}
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          {browser.accounts.map((a) => (
            <SelectItem key={a.id} value={a.id}>
              {a.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Select
        value={browser.teamId}
        onValueChange={(v) => browser.setTeam(v ?? "")}
        disabled={!browser.accountId || browser.teamsLoading}
      >
        <SelectTrigger className="min-w-40 max-w-56">
          <SelectValue
            placeholder={browser.teamsLoading ? "Loading workspaces..." : "Workspace"}
          >
            {label(browser.teams, (t) => t.id, (t) => t.name)}
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          {browser.teams.map((t) => (
            <SelectItem key={t.id} value={t.id}>
              {t.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Select
        value={browser.spaceId}
        onValueChange={(v) => browser.setSpace(v ?? "")}
        disabled={!browser.teamId || browser.spacesLoading}
      >
        <SelectTrigger className="min-w-40 max-w-56">
          <SelectValue
            placeholder={browser.spacesLoading ? "Loading spaces..." : "Space"}
          >
            {label(browser.spaces, (s) => s.id, (s) => s.name)}
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          {browser.spaces.map((s) => (
            <SelectItem key={s.id} value={s.id}>
              {s.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {/* Combobox, not a Select: a space routinely holds dozens of lists whose
          names are long and share prefixes ("V0.3.0 / …"), so the picker needs
          type-to-filter and room to show a name in full. Same shape as the
          GitHub repo and project pickers. */}
      <Popover open={listPickerOpen} onOpenChange={setListPickerOpen}>
        <PopoverTrigger
          nativeButton
          disabled={!browser.spaceId || browser.listsLoading}
          render={
            <Button
              variant="outline"
              size="sm"
              className="flex-1 min-w-40 justify-between font-normal h-8"
            />
          }
        >
          <span className={cn("truncate", !selectedList && "text-muted-foreground")}>
            {selectedList
              ? listLabel(selectedList)
              : browser.listsLoading
                ? "Loading lists..."
                : "List"}
          </span>
          <ChevronsUpDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        </PopoverTrigger>
        <PopoverContent className="p-0 w-96" align="start">
          <Command>
            <CommandInput placeholder="Search lists..." />
            <CommandList>
              <CommandEmpty>No list found.</CommandEmpty>
              {browser.lists.map((l) => (
                <CommandItem
                  key={l.id}
                  value={listLabel(l)}
                  onSelect={() => {
                    browser.setList(l.id);
                    setListPickerOpen(false);
                  }}
                >
                  <Check
                    className={cn(
                      "h-3.5 w-3.5",
                      browser.listId === l.id ? "opacity-100" : "opacity-0"
                    )}
                  />
                  <span className="truncate flex-1">{listLabel(l)}</span>
                  {l.taskCount != null && (
                    <span className="text-muted-foreground text-xs shrink-0">
                      {l.taskCount}
                    </span>
                  )}
                </CommandItem>
              ))}
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>

      {browser.listId && (
        <Button
          variant="outline"
          size="sm"
          onClick={() => browser.syncMutation.mutate()}
          disabled={browser.syncMutation.isPending}
          title="Sync tasks from ClickUp"
        >
          {browser.syncMutation.isPending ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <RefreshCw className="h-4 w-4" />
          )}
        </Button>
      )}
    </div>
  );
}

export function ClickUpTaskPicker({ projectId, featureId }: TaskPickerProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const browser = useClickUpBrowser(open);

  const { data: tasks = [], isLoading: tasksLoading } = useQuery<CachedClickUpTask[]>({
    queryKey: ["clickup-tasks", browser.accountId, browser.listId, search],
    queryFn: async () => {
      const params = new URLSearchParams({
        accountId: browser.accountId,
        listId: browser.listId,
        includeClosed: "true",
        ...(search ? { search } : {}),
      });
      const res = await fetch(`/api/clickup/tasks?${params}`);
      if (!res.ok) throw new Error("Failed to load tasks");
      return res.json();
    },
    enabled: !!browser.accountId && !!browser.listId,
  });

  const linkMutation = useMutation({
    mutationFn: async (taskId: string) => {
      const res = await fetch(
        `/api/projects/${projectId}/features/${featureId}/clickup-tasks`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ taskId }),
        }
      );
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Failed to link task");
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ["feature-clickup-tasks", featureId],
      });
      toast({ title: "ClickUp task linked to feature" });
    },
    onError: (err: Error) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const { data: linked = [] } = useQuery<LinkedTask[]>({
    queryKey: ["feature-clickup-tasks", featureId],
    queryFn: async () => {
      const res = await fetch(
        `/api/projects/${projectId}/features/${featureId}/clickup-tasks`
      );
      if (!res.ok) throw new Error("Failed to load linked tasks");
      return res.json();
    },
    enabled: open,
  });

  const linkedIds = new Set(linked.map((l) => l.task.id));

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger nativeButton render={<Button variant="outline" size="sm" className="gap-1.5" />}>
        <CheckSquare className="h-3.5 w-3.5" />
        Link Tasks
      </DialogTrigger>
      <DialogContent className="sm:max-w-2xl max-h-[90vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <CheckSquare className="h-5 w-5" />
            Link ClickUp Tasks
          </DialogTitle>
          <DialogDescription>
            Select tasks from your ClickUp lists to associate with this feature.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3 flex-1 min-h-0">
          <ClickUpBrowserSelects browser={browser} />

          {browser.listId && (
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Search tasks..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="pl-9"
              />
            </div>
          )}

          {/* Native overflow, not ScrollArea — see clickup-import-dialog. */}
          <div className="flex-1 min-h-0 overflow-y-auto border rounded-md">
            {!browser.accountId ? (
              <div className="py-12 text-center text-sm text-muted-foreground">
                <CheckSquare className="h-8 w-8 mx-auto mb-2 opacity-40" />
                Select a ClickUp account to get started.
                <br />
                <a
                  href="/settings?tab=integrations"
                  className="text-primary hover:underline mt-1 inline-block"
                >
                  Connect an account in Settings →
                </a>
              </div>
            ) : !browser.listId ? (
              <div className="py-12 text-center text-sm text-muted-foreground">
                Pick a workspace, space and list to browse tasks.
              </div>
            ) : tasksLoading ? (
              <div className="py-12 flex items-center justify-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                Loading tasks...
              </div>
            ) : tasks.length === 0 ? (
              <div className="py-12 text-center text-sm text-muted-foreground">
                No tasks found.
                <br />
                <button
                  onClick={() => browser.syncMutation.mutate()}
                  className="text-primary hover:underline mt-1"
                  disabled={browser.syncMutation.isPending}
                >
                  Sync from ClickUp →
                </button>
              </div>
            ) : (
              <div className="divide-y">
                {tasks.map((task) => {
                  const isLinked = linkedIds.has(task.id);
                  return (
                    <div
                      key={task.id}
                      className="flex items-start gap-3 px-3 py-2.5 hover:bg-muted/40"
                    >
                      <TaskStateIcon statusType={task.statusType} />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-start gap-2">
                          <span className="text-sm font-medium line-clamp-1 flex-1">
                            {task.name}
                          </span>
                          <a
                            href={task.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="shrink-0 text-muted-foreground hover:text-foreground"
                            onClick={(e) => e.stopPropagation()}
                          >
                            <ExternalLink className="h-3.5 w-3.5" />
                          </a>
                        </div>
                        <div className="flex items-center gap-1.5 mt-0.5 flex-wrap">
                          {task.status && (
                            <span className="text-xs text-muted-foreground">
                              {task.status}
                            </span>
                          )}
                          {task.priority && (
                            <Badge variant="outline" className="text-xs py-0">
                              {task.priority}
                            </Badge>
                          )}
                          {task.tags?.slice(0, 3).map((t) => (
                            <Badge key={t} variant="secondary" className="text-xs py-0">
                              {t}
                            </Badge>
                          ))}
                        </div>
                      </div>
                      <Button
                        size="sm"
                        variant={isLinked ? "secondary" : "outline"}
                        className="shrink-0 h-7 text-xs"
                        onClick={() => !isLinked && linkMutation.mutate(task.id)}
                        disabled={isLinked || linkMutation.isPending}
                      >
                        {isLinked ? "Linked" : "Link"}
                      </Button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
