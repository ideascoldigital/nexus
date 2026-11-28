"use client";

// Global ⌘K palette (design 1h / M3): navigation + projects, and — when
// inside a project — semantic search over its index (code, features,
// definition document, conversations) in one ranked list.

import { useCallback, useEffect, useMemo, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import {
  BotMessageSquare,
  FileCode2,
  FileText,
  FolderKanban,
  ListTodo,
  MessageSquareCode,
  Settings,
} from "lucide-react";

import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command";
import {
  getProjects,
  searchProject,
  type GroupedSearchResults,
} from "@/services/projects";

const NAV = [
  { label: "Bots", href: "/bots", icon: BotMessageSquare },
  { label: "Settings", href: "/settings", icon: Settings },
];

function useDebounced(value: string, ms: number): string {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return debounced;
}

export function CommandPalette({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const [query, setQuery] = useState("");
  const debouncedQuery = useDebounced(query, 250);

  // Inside a project, ⌘K also searches its semantic index.
  const projectId = useMemo(() => {
    const m = pathname.match(/^\/projects\/([^/?]+)/);
    return m && m[1] !== "new" ? m[1] : null;
  }, [pathname]);

  useEffect(() => {
    if (!open) setQuery("");
  }, [open]);

  const projects = useQuery({
    queryKey: ["projects"],
    queryFn: getProjects,
    enabled: open,
    staleTime: 30_000,
  });

  const workspaces = useQuery({
    queryKey: ["workspaces"],
    queryFn: async () => {
      const res = await fetch("/api/workspaces");
      if (!res.ok) throw new Error("Failed to load workspaces");
      return res.json() as Promise<{
        activeId: string;
        workspaces: Array<{
          id: string;
          name: string;
          icon: string | null;
          logo: string | null;
          projectCount: number;
        }>;
      }>;
    },
    enabled: open,
    staleTime: 30_000,
  });

  const switchWorkspace = useCallback(async (id: string) => {
    await fetch("/api/workspaces/activate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    });
    window.location.href = "/";
  }, []);

  const semantic = useQuery<GroupedSearchResults>({
    queryKey: ["palette-search", projectId, debouncedQuery],
    queryFn: () => searchProject(projectId!, debouncedQuery, { k: 5 }),
    enabled: open && projectId !== null && debouncedQuery.trim().length > 2,
    staleTime: 30_000,
    retry: false,
  });

  const go = useCallback(
    (href: string) => {
      onOpenChange(false);
      router.push(href);
    },
    [onOpenChange, router],
  );

  const semanticItems = useMemo(() => {
    if (!semantic.data || !projectId) return [];
    const items: Array<{
      id: string;
      kind: string;
      title: string;
      meta: string;
      score: number;
      href: string;
      icon: typeof FileCode2;
    }> = [];
    for (const h of semantic.data.repos.slice(0, 5)) {
      items.push({
        id: `repo-${h.sourceId}-${h.chunkIndex}`,
        kind: "code",
        title: h.filePath,
        meta: h.snippet.replace(/\s+/g, " ").trim().slice(0, 80),
        score: h.score,
        href: `/projects/${projectId}?tab=search`,
        icon: FileCode2,
      });
    }
    for (const h of semantic.data.projectData.slice(0, 4)) {
      items.push({
        id: `data-${h.sourceId}-${h.chunkIndex}`,
        kind: h.sourceType === "feature" ? "feature" : "documento",
        title: h.heading ?? h.filePath,
        meta: h.snippet.replace(/\s+/g, " ").trim().slice(0, 80),
        score: h.score,
        href:
          h.sourceType === "feature"
            ? `/projects/${projectId}?tab=features`
            : `/projects/${projectId}?tab=definition`,
        icon: h.sourceType === "feature" ? ListTodo : FileText,
      });
    }
    for (const h of semantic.data.conversations.slice(0, 3)) {
      items.push({
        id: `conv-${h.sourceId}-${h.chunkIndex}`,
        kind: "chat",
        title: h.snippet.replace(/\s+/g, " ").trim().slice(0, 70),
        meta: "indexed conversation",
        score: h.score,
        href: `/projects/${projectId}?tab=search`,
        icon: MessageSquareCode,
      });
    }
    return items.sort((a, b) => b.score - a.score).slice(0, 10);
  }, [semantic.data, projectId]);

  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Search everything"
      description="Navigate, open projects, or semantically search the current project"
      className="sm:max-w-2xl"
    >
      <Command shouldFilter={semanticItems.length === 0}>
      <CommandInput
        placeholder={
          projectId
            ? "Search everything — code, features, document, chats…"
            : "Search — pages and projects…"
        }
        value={query}
        onValueChange={setQuery}
      />
      <CommandList className="max-h-[28rem]">
        <CommandEmpty>
          {semantic.isFetching ? "Searching the index…" : "No results."}
        </CommandEmpty>

        {semanticItems.length > 0 && (
          <>
            <CommandGroup heading="Semantic index">
              {semanticItems.map((item) => (
                <CommandItem
                  key={item.id}
                  value={item.id}
                  onSelect={() => go(item.href)}
                >
                  <item.icon className="h-3.5 w-3.5 text-primary" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-xs">{item.title}</div>
                    <div className="truncate text-[10px] text-muted-foreground">
                      {item.meta}
                    </div>
                  </div>
                  <span className="font-mono text-[10px] text-muted-foreground">
                    {item.kind} · {item.score.toFixed(2)}
                  </span>
                </CommandItem>
              ))}
            </CommandGroup>
            <CommandSeparator />
          </>
        )}

        {(projects.data?.length ?? 0) > 0 && (
          <>
            <CommandGroup heading="Projects">
              {projects.data!.map((p) => (
                <CommandItem
                  key={p.id}
                  value={`project ${p.name}`}
                  onSelect={() => go(`/projects/${p.id}`)}
                >
                  <FolderKanban className="h-3.5 w-3.5" />
                  {p.name}
                  <span className="ml-auto font-mono text-[10px] text-muted-foreground">
                    {p._count.features} features
                  </span>
                </CommandItem>
              ))}
            </CommandGroup>
          </>
        )}

        {(workspaces.data?.workspaces.length ?? 0) > 0 && (
          <>
            <CommandSeparator />
            <CommandGroup heading="Workspaces">
              {workspaces.data!.workspaces.map((w) => {
                const active = w.id === workspaces.data!.activeId;
                return (
                  <CommandItem
                    key={w.id}
                    value={`workspace ${w.name}`}
                    onSelect={() => {
                      if (!active) void switchWorkspace(w.id);
                    }}
                  >
                    {w.logo ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={w.logo}
                        alt=""
                        className="h-3.5 w-3.5 rounded-sm object-cover"
                      />
                    ) : (
                      <span className="flex h-3.5 w-3.5 items-center justify-center text-[10px]">
                        {w.icon ?? w.name.slice(0, 1).toUpperCase()}
                      </span>
                    )}
                    {w.name}
                    <span className="ml-auto font-mono text-[10px] text-muted-foreground">
                      {active
                        ? "activo"
                        : `${w.projectCount} project${w.projectCount === 1 ? "" : "s"}`}
                    </span>
                  </CommandItem>
                );
              })}
            </CommandGroup>
          </>
        )}

        <CommandSeparator />
        <CommandGroup heading="Ir a">
          {NAV.map((n) => (
            <CommandItem key={n.href} value={n.label} onSelect={() => go(n.href)}>
              <n.icon className="h-3.5 w-3.5" />
              {n.label}
            </CommandItem>
          ))}
        </CommandGroup>
      </CommandList>
      </Command>
    </CommandDialog>
  );
}
