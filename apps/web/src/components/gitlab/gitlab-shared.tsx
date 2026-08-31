"use client";

// Pieces both GitLab surfaces need — the import dialog (kanban header) and the
// link picker (feature drawer). GitHub grew two near-identical copies of its
// account/repo cascade; this keeps GitLab's single source.

import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
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
import { BrandIcon } from "@/components/ui/brand-icon";
import { Check, ChevronsUpDown, CircleCheck, CircleDot } from "lucide-react";
import { cn } from "@/lib/utils";

/** A registered GitLab server (a `ConnectedAccount` with providerType gitlab). */
export interface GitLabAccount {
  id: string;
  label: string;
  status: string;
  lastCheckedAt: string | null;
  metadata: {
    baseUrl: string;
    credentialId?: string | null;
    username?: string;
    name?: string | null;
    avatar_url?: string | null;
    web_url?: string;
  } | null;
}

export interface GitLabProjectSummary {
  id: number;
  name: string;
  path_with_namespace: string;
  open_issues_count?: number;
}

export interface GitLabGroupSummary {
  id: number;
  name: string;
  full_path: string;
}

/** A cached `GitLabEpic` row. */
export interface CachedGitLabEpic {
  id: string;
  /** GitLab's global id — what an issue's `epicId` points at. */
  epicId: number;
  epicIid: number;
  groupId: number;
  groupPath: string;
  title: string;
  body: string | null;
  state: string;
  url: string;
  labels: string[] | null;
}

/** What the import dialog is scoped by. */
export type GitLabScope = "project" | "group" | "epic";

/** A cached `GitLabIssue` row, as the API hands it back. */
export interface CachedGitLabIssue {
  id: string;
  projectId: number;
  projectPath: string;
  issueIid: number;
  title: string;
  body: string | null;
  state: string;
  url: string;
  author: string | null;
  labels: string[] | null;
  milestone: string | null;
  /** Denormalized from the issue payload; null when it hangs off no epic. */
  epicId?: number | null;
  epicIid?: number | null;
  epicTitle?: string | null;
  /** Board column the issue sits in — a GitLab 18 work-item status. */
  boardStatus?: string | null;
  /** Kanban status the server derived from that column, or from open/closed. */
  suggestedStatus?: string;
}

export function GitLabStateIcon({ state }: { state: string }) {
  return state === "opened" ? (
    <CircleDot className="h-3.5 w-3.5 text-orange-500 shrink-0" />
  ) : (
    <CircleCheck className="h-3.5 w-3.5 text-blue-500 shrink-0" />
  );
}

/**
 * GitLab labels are plain strings over the REST API — no colour comes back
 * with them, so these are neutral chips rather than GitHub's tinted ones.
 */
export function GitLabLabelBadge({ label }: { label: string }) {
  return (
    <span className="inline-flex items-center rounded border px-1.5 py-0.5 text-xs font-medium text-muted-foreground">
      {label}
    </span>
  );
}

/** The instance a server points at, without the scheme, for compact labels. */
export function instanceHost(account?: GitLabAccount | null): string {
  const base = account?.metadata?.baseUrl;
  if (!base) return "";
  return base.replace(/^https?:\/\//i, "");
}

export function useGitLabAccounts(enabled = true) {
  return useQuery<GitLabAccount[]>({
    queryKey: ["gitlab-accounts"],
    queryFn: async () => {
      const res = await fetch("/api/gitlab/accounts");
      if (!res.ok) throw new Error("Failed to load GitLab servers");
      return res.json();
    },
    enabled,
  });
}

/** Server picker — shows the instance host so two logins never look alike. */
export function GitLabAccountSelect({
  accounts,
  value,
  onChange,
  className,
}: {
  accounts: GitLabAccount[];
  value: string;
  onChange: (accountId: string) => void;
  className?: string;
}) {
  return (
    <Select value={value} onValueChange={(v) => onChange(v ?? "")}>
      <SelectTrigger className={cn("w-52", className)}>
        <SelectValue placeholder="GitLab server">
          {(v: unknown) =>
            accounts.find((a) => a.id === v)?.label ?? String(v ?? "")
          }
        </SelectValue>
      </SelectTrigger>
      <SelectContent>
        {accounts.map((a) => (
          <SelectItem key={a.id} value={a.id}>
            {a.label}
            <span className="text-muted-foreground ml-1">
              ({instanceHost(a)})
            </span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** A debounced term, so a picker searches on pause rather than per keystroke. */
function useDebounced(value: string, ms = 300): string {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return debounced;
}

/**
 * The combobox behind all three scope pickers.
 *
 * Searching is the caller's job — the project and group pickers ask the
 * instance, the epic picker asks the local cache — but the shell around it is
 * identical, and three hand-rolled copies is how the GitHub side ended up with
 * two account/repo cascades that no longer quite match.
 */
function SearchCombobox<T>({
  items,
  isLoading,
  selectedKey,
  keyOf,
  labelOf,
  hintOf,
  onSelect,
  onSearch,
  placeholder,
  triggerLabel,
  emptyLabel,
  disabled,
  className,
}: {
  items: T[];
  isLoading: boolean;
  selectedKey: string | null;
  keyOf: (item: T) => string;
  labelOf: (item: T) => string;
  hintOf?: (item: T) => string | null;
  onSelect: (item: T) => void;
  onSearch: (term: string) => void;
  placeholder: string;
  triggerLabel: string | null;
  emptyLabel: string;
  disabled?: boolean;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [term, setTerm] = useState("");
  const debounced = useDebounced(term);

  useEffect(() => {
    onSearch(debounced);
    // `onSearch` is a setState from the caller; re-running on its identity
    // would loop on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debounced]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        nativeButton
        disabled={disabled}
        render={
          <Button
            variant="outline"
            size="sm"
            className={cn(
              "flex-1 min-w-40 justify-between font-normal h-8",
              className,
            )}
          />
        }
      >
        <span className={cn("truncate", !triggerLabel && "text-muted-foreground")}>
          {triggerLabel ?? placeholder}
        </span>
        <ChevronsUpDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      </PopoverTrigger>
      <PopoverContent className="p-0 w-96" align="start">
        {/* shouldFilter off — whoever supplied `items` already filtered, and
            cmdk's fuzzy pass would drop rows that were matched deliberately. */}
        <Command shouldFilter={false}>
          <CommandInput
            placeholder={placeholder}
            value={term}
            onValueChange={setTerm}
          />
          <CommandList>
            <CommandEmpty>{isLoading ? "Searching…" : emptyLabel}</CommandEmpty>
            {items.map((item) => {
              const key = keyOf(item);
              const hint = hintOf?.(item);
              return (
                <CommandItem
                  key={key}
                  value={key}
                  onSelect={() => {
                    onSelect(item);
                    setOpen(false);
                  }}
                >
                  <Check
                    className={cn(
                      "h-3.5 w-3.5",
                      selectedKey === key ? "opacity-100" : "opacity-0",
                    )}
                  />
                  <span className="truncate flex-1">{labelOf(item)}</span>
                  {hint ? (
                    <span className="text-muted-foreground text-xs shrink-0">
                      {hint}
                    </span>
                  ) : null}
                </CommandItem>
              );
            })}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

/**
 * Project combobox.
 *
 * The search is sent to the instance rather than filtering what was already
 * fetched: a company server routinely has more projects than the first few
 * pages hold, so client-side filtering would hide exactly the project someone
 * is hunting for. Typing a full `group/subgroup/project` path resolves it
 * directly, which is the escape hatch when even search misses.
 */
export function GitLabProjectPicker({
  accountId,
  value,
  onChange,
  className,
}: {
  accountId: string;
  value: GitLabProjectSummary | null;
  onChange: (project: GitLabProjectSummary | null) => void;
  className?: string;
}) {
  const [search, setSearch] = useState("");
  const looksLikePath = /^[^\s/]+(\/[^\s/]+)+$/.test(search.trim());

  const { data: projects = [], isLoading } = useQuery<GitLabProjectSummary[]>({
    queryKey: ["gitlab-projects", accountId, search, looksLikePath],
    queryFn: async () => {
      const params = new URLSearchParams(
        looksLikePath
          ? { path: search.trim() }
          : search.trim()
            ? { search: search.trim() }
            : {},
      );
      const res = await fetch(
        `/api/gitlab/accounts/${accountId}/projects?${params}`,
      );
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || "Failed to load projects");
      }
      return res.json();
    },
    enabled: !!accountId,
    // A path that does not resolve is a 404, and retrying it three times just
    // delays the "not found" the user needs to see.
    retry: false,
  });

  return (
    <SearchCombobox
      items={projects}
      isLoading={isLoading}
      selectedKey={value ? String(value.id) : null}
      keyOf={(p) => String(p.id)}
      labelOf={(p) => p.path_with_namespace}
      hintOf={(p) => (p.open_issues_count ? String(p.open_issues_count) : null)}
      onSelect={onChange}
      onSearch={setSearch}
      placeholder="Search projects, or paste group/project…"
      triggerLabel={value?.path_with_namespace ?? null}
      emptyLabel="No project found."
      disabled={!accountId}
      className={className}
    />
  );
}

/**
 * Group combobox — subgroups included, because that is where the work lives.
 * `civo/dashboard` is a useful import; its parent `civo` is 3476 issues.
 */
export function GitLabGroupPicker({
  accountId,
  value,
  onChange,
  className,
}: {
  accountId: string;
  value: GitLabGroupSummary | null;
  onChange: (group: GitLabGroupSummary) => void;
  className?: string;
}) {
  const [search, setSearch] = useState("");

  const { data: groups = [], isLoading } = useQuery<GitLabGroupSummary[]>({
    queryKey: ["gitlab-groups", accountId, search],
    queryFn: async () => {
      const params = new URLSearchParams(
        search.trim() ? { search: search.trim() } : {},
      );
      const res = await fetch(
        `/api/gitlab/accounts/${accountId}/groups?${params}`,
      );
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || "Failed to load groups");
      }
      return res.json();
    },
    enabled: !!accountId,
    retry: false,
  });

  return (
    <SearchCombobox
      items={groups}
      isLoading={isLoading}
      selectedKey={value ? String(value.id) : null}
      keyOf={(g) => String(g.id)}
      labelOf={(g) => g.full_path}
      onSelect={onChange}
      onSearch={setSearch}
      placeholder="Search groups and subgroups…"
      triggerLabel={value?.full_path ?? null}
      emptyLabel="No group found."
      disabled={!accountId}
      className={className}
    />
  );
}

/**
 * Epic combobox, read from the local cache rather than live.
 *
 * Unlike projects and groups this one is behind a sync, which is the rhythm the
 * rest of this dialog already has (sync, then review what was cached). The
 * trade is honest: the list is as fresh as the last sync, and a group with 1731
 * epics is searched locally instead of costing a request per keystroke.
 */
export function GitLabEpicPicker({
  accountId,
  group,
  value,
  onChange,
  className,
}: {
  accountId: string;
  group: GitLabGroupSummary | null;
  value: CachedGitLabEpic | null;
  onChange: (epic: CachedGitLabEpic) => void;
  className?: string;
}) {
  const [search, setSearch] = useState("");

  const { data: epics = [], isLoading } = useQuery<CachedGitLabEpic[]>({
    queryKey: ["gitlab-epics", accountId, group?.id, search],
    queryFn: async () => {
      const params = new URLSearchParams({
        accountId,
        groupId: String(group!.id),
        groupPath: group!.full_path,
        state: "all",
        ...(search.trim() ? { search: search.trim() } : {}),
      });
      const res = await fetch(`/api/gitlab/epics?${params}`);
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || "Failed to load epics");
      }
      return res.json();
    },
    enabled: !!accountId && !!group,
    retry: false,
  });

  return (
    <SearchCombobox
      items={epics}
      isLoading={isLoading}
      selectedKey={value ? String(value.epicId) : null}
      keyOf={(e) => String(e.epicId)}
      labelOf={(e) => `&${e.epicIid}  ${e.title}`}
      hintOf={(e) => (e.state === "closed" ? "closed" : null)}
      onSelect={onChange}
      onSearch={setSearch}
      placeholder="Search epics…"
      triggerLabel={value ? `&${value.epicIid}  ${value.title}` : null}
      emptyLabel="No epic cached — sync this group first."
      disabled={!group}
      className={className}
    />
  );
}

/** Empty state shared by both surfaces when no server is registered yet. */
export function NoGitLabServer({ action }: { action: string }) {
  return (
    <div className="py-12 text-center text-sm text-muted-foreground border rounded-md">
      <BrandIcon brand="gitlab" className="h-8 w-8 mx-auto mb-2 opacity-40" />
      Select a GitLab server to {action}.
      <br />
      <a
        href="/settings?tab=integrations"
        className="text-primary hover:underline mt-1 inline-block"
      >
        Add a server in Settings →
      </a>
    </div>
  );
}
