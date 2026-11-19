"use client";

import { use, useEffect, useRef, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { formatDistanceToNow } from "date-fns";
import {
  BookOpenText,
  ChevronDown,
  ChevronRight,
  Terminal,
} from "lucide-react";

import { AppHeader } from "@/components/layout/app-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Skeleton } from "@/components/ui/skeleton";
import { LG_BREAKPOINT, useBelowBreakpoint } from "@/hooks/use-breakpoint";
import {
  ResizableGroup,
  ResizableHandle,
  ResizablePanel,
} from "@/components/ui/resizable";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  DialogClose,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import {
  getProject,
  getIndexStatus,
  updateProject,
  deleteProject,
} from "@/services/projects";
import { ProjectAutoIndexer } from "@/components/projects/project-auto-indexer";
import { ProjectSetupChecklist } from "@/components/projects/project-setup-checklist";
import {
  SetupSections,
  type SetupSection,
} from "@/components/projects/overview-sections";
import { ProjectRepositories } from "@/components/projects/project-repositories";
import { FeatureList } from "@/components/features/feature-list";
import { TerminalManager } from "@/components/terminal/terminal-manager";
import { ProjectDefinition } from "@/components/definition/project-definition";
import { ProjectSandboxes } from "@/components/projects/project-sandboxes";
import { TaskNotifier } from "@/components/projects/task-notifier";
import { ExportProjectDialog } from "@/components/projects/export-project-dialog";

function EditProjectDialog({
  project,
}: {
  project: {
    id: string;
    name: string;
    description: string | null;
  };
}) {
  const [open, setOpen] = useState(false);
  const queryClient = useQueryClient();

  const [name, setName] = useState(project.name);
  const [description, setDescription] = useState(project.description ?? "");
  const [workspaceId, setWorkspaceId] = useState<string>("");

  const workspaces = useQuery({
    queryKey: ["workspaces"],
    queryFn: async () => {
      const res = await fetch("/api/workspaces");
      if (!res.ok) throw new Error("Failed to load workspaces");
      return res.json() as Promise<{
        activeId: string;
        workspaces: Array<{ id: string; name: string; icon: string | null }>;
      }>;
    },
    enabled: open,
  });

  const mutation = useMutation({
    mutationFn: (data: Parameters<typeof updateProject>[1]) =>
      updateProject(project.id, data),
    onSuccess: (_data, vars) => {
      queryClient.invalidateQueries({ queryKey: ["project", project.id] });
      queryClient.invalidateQueries({ queryKey: ["projects"] });
      queryClient.invalidateQueries({ queryKey: ["projects-overview"] });
      queryClient.invalidateQueries({ queryKey: ["workspaces"] });
      setOpen(false);
      // Moved out of the active workspace — the project vanishes from every
      // scoped list here, so land the user on the projects page.
      if (
        vars &&
        "workspaceId" in vars &&
        vars.workspaceId &&
        vars.workspaceId !== workspaces.data?.activeId
      ) {
        window.location.href = "/projects";
      }
    },
  });

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    mutation.mutate({
      name,
      description: description || undefined,
      ...(workspaceId ? { workspaceId } : {}),
    });
  }

  function handleOpenChange(nextOpen: boolean) {
    if (nextOpen) {
      setName(project.name);
      setDescription(project.description ?? "");
      setWorkspaceId("");
    }
    setOpen(nextOpen);
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger
        nativeButton={true}
        render={
          <Button variant="outline" size="sm" className="gap-1.5">
            Edit
          </Button>
        }
      />
      <DialogContent className="sm:max-w-md">
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>Edit Project</DialogTitle>
            <DialogDescription>Update project details.</DialogDescription>
          </DialogHeader>

          <div className="grid gap-4 py-4">
            <div className="grid gap-2">
              <Label htmlFor="edit-name">Name</Label>
              <Input
                id="edit-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="edit-description">Description</Label>
              <Textarea
                id="edit-description"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={3}
              />
            </div>
            {(workspaces.data?.workspaces.length ?? 0) > 1 && (
              <div className="grid gap-2">
                <Label>Workspace</Label>
                <Select
                  value={workspaceId || (workspaces.data?.activeId ?? "")}
                  onValueChange={(v) => setWorkspaceId((v as string) ?? "")}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue>
                      {(v) =>
                        workspaces.data?.workspaces.find((w) => w.id === v)
                          ?.name ?? "…"
                      }
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {workspaces.data?.workspaces.map((w) => (
                      <SelectItem key={w.id} value={w.id}>
                        {w.icon ? `${w.icon} ` : ""}
                        {w.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-[10px] text-muted-foreground">
                  Moving keeps the project intact (sandboxes, tasks, attached
                  agents/skills); catalogs and credentials stay per-workspace,
                  so pick replacements there if needed.
                </p>
              </div>
            )}
          </div>

          {mutation.isError && (
            <p className="text-xs text-destructive pb-4">
              {mutation.error.message}
            </p>
          )}

          <DialogFooter>
            <Button
              type="submit"
              disabled={mutation.isPending}
              className="gap-1.5"
            >
              {mutation.isPending ? "Saving..." : "Save Changes"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function DeleteProjectDialog({
  projectId,
  projectName,
}: {
  projectId: string;
  projectName: string;
}) {
  const [open, setOpen] = useState(false);
  const router = useRouter();
  const queryClient = useQueryClient();

  const mutation = useMutation({
    mutationFn: () => deleteProject(projectId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["projects"] });
      setOpen(false);
      router.push("/projects");
    },
  });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        nativeButton={true}
        render={
          <Button variant="destructive" size="sm" className="gap-1.5">
            Delete
          </Button>
        }
      />
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Delete Project</DialogTitle>
          <DialogDescription>
            Are you sure you want to delete &quot;{projectName}&quot;? This will
            permanently remove all features, conversations, and plans associated
            with this project.
          </DialogDescription>
        </DialogHeader>
        {mutation.isError && (
          <p className="text-xs text-destructive">
            {mutation.error.message}
          </p>
        )}
        <DialogFooter>
          <DialogClose render={<Button variant="outline" />}>
            Cancel
          </DialogClose>
          <Button
            variant="destructive"
            disabled={mutation.isPending}
            onClick={() => mutation.mutate()}
          >
            {mutation.isPending ? "Deleting..." : "Delete"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** "● N fuentes" right of the tab bar (prototype's indexStatus). */
function ProjectIndexStatus({ projectId }: { projectId: string }) {
  const { data } = useQuery({
    queryKey: ["embedding-index-status", projectId],
    queryFn: () => getIndexStatus(projectId),
    refetchInterval: 30_000,
  });
  if (!data || data.total === 0) return null;
  return (
    <span className="hidden sm:block whitespace-nowrap font-mono text-[11px] text-primary">
      ● {data.total.toLocaleString()} fuentes
    </span>
  );
}

export default function ProjectDetailPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = use(params);

  const searchParams = useSearchParams();
  // Setup areas (definition/stack/orchestration/search) live as expandable
  // sections inside Overview; only the operational surfaces remain as tabs.
  const validProjectTabs = [
    "overview",
    "features",
    "sandboxes",
    "terminal",
  ] as const;
  type ProjectTab = (typeof validProjectTabs)[number];
  // The Overview folds Definition + these three as accordions — exactly one
  // open at a time. Definition opens by default.
  const setupSections = ["stack", "orchestration", "search"] as const;
  type OverviewSection = "definition" | SetupSection;
  const overviewSections = ["definition", ...setupSections] as const;
  const sectionStorageKey = `nexux:project:${projectId}:section`;
  const tabStorageKey = `nexux:project:${projectId}:tab`;
  // Resolve tab + open section from one source, URL first. Reading location
  // directly (not the useSearchParams snapshot, which lags our replaceState
  // writes) keeps this correct whenever it re-runs.
  const readState = (): {
    tab: ProjectTab;
    section: OverviewSection | null;
  } => {
    const params =
      typeof window === "undefined"
        ? new URLSearchParams(searchParams.toString())
        : new URLSearchParams(window.location.search);
    const tabParam = params.get("tab");
    const sectionParam = params.get("section");
    const isTab = (v: string | null) =>
      (validProjectTabs as readonly string[]).includes(v ?? "");
    const isSection = (v: string | null) =>
      (overviewSections as readonly string[]).includes(v ?? "");
    // A legacy ?tab=<section> link opens Overview with that section.
    const tab: ProjectTab = isTab(tabParam)
      ? (tabParam as ProjectTab)
      : isSection(tabParam)
        ? "overview"
        : "overview";
    if (isSection(sectionParam))
      return { tab, section: sectionParam as OverviewSection };
    if (isSection(tabParam))
      return { tab, section: tabParam as OverviewSection };
    // No section in the URL: only then fall back to the last one the user had
    // open. An explicit ?tab= means a deliberate link, so don't second-guess it.
    if (!sectionParam && typeof window !== "undefined") {
      const stored = localStorage.getItem(sectionStorageKey);
      if (isSection(stored)) return { tab, section: stored as OverviewSection };
    }
    return { tab, section: null };
  };
  const [initial] = useState(readState);
  // Below lg the overview stacks. That has to be a render decision rather than
  // a class: react-resizable-panels writes pixel widths inline, so `lg:flex-col`
  // leaves the rail at ~108px on a phone with its content shredded.
  const stacked = useBelowBreakpoint(LG_BREAKPOINT);

  const [activeProjectTab, setActiveProjectTab] = useState<ProjectTab>(
    initial.tab,
  );
  const [openSection, setOpenSection] = useState<OverviewSection | null>(
    initial.section,
  );
  // Mirror the open accordion into ?section= (shareable links) and
  // localStorage (survives reloads that land on a bare URL).
  const setSection = (section: OverviewSection | null) => {
    setOpenSection(section);
    if (typeof window === "undefined") return;
    if (section) localStorage.setItem(sectionStorageKey, section);
    else localStorage.removeItem(sectionStorageKey);
    const url = new URL(window.location.href);
    if (section) url.searchParams.set("section", section);
    else url.searchParams.delete("section");
    window.history.replaceState(window.history.state, "", url.toString());
  };
  // Write the restored state back into the URL so a reload or a copied link
  // carries it. Mount only — later changes go through the setters.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const url = new URL(window.location.href);
    url.searchParams.set("tab", initial.tab);
    if (initial.section) url.searchParams.set("section", initial.section);
    window.history.replaceState(window.history.state, "", url.toString());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // Back/forward and in-app links change the router's params without
  // remounting; re-resolve from the URL then. Our own replaceState writes
  // don't notify useSearchParams, so this won't fight the setters.
  const isFirstSync = useRef(true);
  useEffect(() => {
    if (isFirstSync.current) {
      isFirstSync.current = false;
      return;
    }
    const next = readState();
    setActiveProjectTab(next.tab);
    setOpenSection(next.section);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);
  const definitionOpen = openSection === "definition";
  // Handoff from the Sandboxes tab to the Terminal tab. Passed to
  // TerminalManager as a prop — a URL param wouldn't work here because
  // history.replaceState doesn't notify useSearchParams.
  const [sshRequest, setSshRequest] = useState<{
    target: string;
    label: string;
    nonce: number;
  } | null>(null);
  const setProjectTab = (value: string) => {
    if (!(validProjectTabs as readonly string[]).includes(value)) return;
    setActiveProjectTab(value as ProjectTab);
    if (typeof window === "undefined") return;
    localStorage.setItem(tabStorageKey, value);
    const url = new URL(window.location.href);
    url.searchParams.set("tab", value);
    window.history.replaceState(window.history.state, "", url.toString());
  };
  /** Open Overview with one section expanded (checklist + handoffs). */
  const openSetupSection = (section: string) => {
    if ((overviewSections as readonly string[]).includes(section)) {
      setSection(section as OverviewSection);
      setProjectTab("overview");
    } else if (section === "repos") {
      setProjectTab("overview");
    } else {
      setProjectTab(section);
    }
  };

  const {
    data: project,
    isLoading,
    isError,
  } = useQuery({
    queryKey: ["project", projectId],
    queryFn: () => getProject(projectId),
  });

  if (isLoading) {
    return (
      <>
        <AppHeader title="Loading..." />
        <div className="flex-1 overflow-auto">
          <div className="mx-auto w-full max-w-page px-4 py-6 space-y-4">
            <Skeleton className="h-8 w-48" />
            <Skeleton className="h-[300px] rounded-xl" />
          </div>
        </div>
      </>
    );
  }

  if (isError || !project) {
    return (
      <>
        <AppHeader title="Project" />
        <div className="flex-1 overflow-auto">
          <div className="mx-auto w-full max-w-page px-4 py-6 space-y-4">
            <div className="flex flex-col items-center justify-center py-16 text-center">
              <p className="text-sm text-destructive mb-4">
                Failed to load project.
              </p>
              <Button
                variant="outline"
                size="sm"
                render={<Link href="/projects" />}
              >
                Back to Projects
              </Button>
            </div>
          </div>
        </div>
      </>
    );
  }

  return (
    <>
      <AppHeader title={project.name} />
      {/* Surfaces sandbox task completions/failures/stalls as toasts. */}
      <TaskNotifier projectId={projectId} />
      {/* Keeps the search index warm: auto-incremental build on open. */}
      <ProjectAutoIndexer projectId={projectId} />
      <div className="flex-1 overflow-auto">
        <div className="mx-auto w-full max-w-page">
          {/* Tab bar attached under the topbar (prototype): tabs left,
              index status + project actions right. */}
          <Tabs value={activeProjectTab} onValueChange={setProjectTab}>
            {/* Scrolls on its own, so the row's natural width cannot widen the
                panel. Without this the tabs plus the action buttons measure
                ~610px, the page's scroller inherits that, and reaching Delete
                on a phone drags the whole tab's content sideways with it —
                you gain the buttons and lose the view you came for.

                `min-w-0` is the half that makes it work: a flex child defaults
                to min-width:auto, so it refuses to shrink below its content
                and the overflow never becomes this element's to scroll. */}
            <div className="flex min-w-0 items-center gap-1 overflow-x-auto border-b border-border/60 bg-sidebar/60 px-5 pt-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
              <TabsList variant="line" className="border-b-0">
                <TabsTrigger value="overview">Overview</TabsTrigger>
                <TabsTrigger value="features">
                  Features ({project._count.features})
                </TabsTrigger>
                <TabsTrigger value="sandboxes">Sandboxes</TabsTrigger>
                <TabsTrigger value="terminal">
                  <Terminal className="h-3.5 w-3.5 mr-1.5" />
                  Terminal
                </TabsTrigger>
              </TabsList>
              <div className="ml-auto flex shrink-0 items-center gap-2 pb-1.5">
                <ProjectIndexStatus projectId={projectId} />
                <ExportProjectDialog
                  projectId={project.id}
                  projectName={project.name}
                />
                <EditProjectDialog project={project} />
                <DeleteProjectDialog
                  projectId={project.id}
                  projectName={project.name}
                />
              </div>
            </div>
            <div className="px-5 pb-6">

            {/* Overview Tab — design 1b: definition hero + accordions on the
                left, checklist + repos on the right. */}
            <TabsContent value="overview">
              {/* Resizable on lg+ so the Stack canvas can borrow width from
                  the checklist rail; stacked (and non-resizable) below that. */}
              <ResizableGroup
                // Below lg this is a plain stacked div, not a split: the
                // library sizes panels inline, so classes cannot stack them,
                // and a vertical group divides a fixed height — which
                // collapses growing content to zero.
                plain={stacked}
                // Only the horizontal layout is worth remembering. A stacked
                // one has nothing to drag, and sharing the key would let a
                // phone visit overwrite the split a desktop user set.
                persistId={stacked ? undefined : "project-overview"}
                className="mt-4 h-auto gap-4 lg:gap-0 lg:items-stretch"
              >
                <ResizablePanel
                  plain={stacked}
                  id="main"
                  defaultSize={stacked ? undefined : "66%"}
                  minSize={stacked ? undefined : "35%"}
                  className="space-y-4 lg:pr-4"
                >
                  {/* Definition — live multi-agent panel, collapsible hero */}
                  <Card className="border-border/50 py-0 gap-0 overflow-hidden">
                    <button
                      type="button"
                      onClick={() =>
                        setSection(definitionOpen ? null : "definition")
                      }
                      className={`flex w-full items-center gap-2.5 px-4 py-3 text-left hover:bg-muted/30 transition-colors ${
                        definitionOpen ? "border-b border-border/40" : ""
                      }`}
                    >
                      {definitionOpen ? (
                        <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                      ) : (
                        <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                      )}
                      <BookOpenText className="h-4 w-4 shrink-0 text-primary" />
                      <span className="text-sm font-medium">Definition</span>
                      <span className="hidden sm:block truncate font-mono text-[11px] text-muted-foreground">
                        documento por fases · chat multi-agente en vivo
                      </span>
                    </button>
                    {definitionOpen && (
                      <div className="p-3">
                        <ProjectDefinition projectId={projectId} />
                      </div>
                    )}
                  </Card>

                  {/* Stack / Orchestrate / Search accordions */}
                  <SetupSections
                    projectId={projectId}
                    openSection={definitionOpen ? null : (openSection as SetupSection | null)}
                    onToggle={setSection}
                    onOpenSandboxes={() => setProjectTab("sandboxes")}
                  />
                </ResizablePanel>

                {/* Not rendered at all when stacked, rather than hidden with
                    a class: a Separator outside a Group throws, and `hidden`
                    still mounts it. */}
                {!stacked && <ResizableHandle />}

                <ResizablePanel
                  plain={stacked}
                  id="rail"
                  defaultSize={stacked ? undefined : "34%"}
                  minSize={stacked ? undefined : "18%"}
                  className="space-y-4 lg:pl-4"
                >
                  <ProjectSetupChecklist
                    projectId={projectId}
                    onNavigate={openSetupSection}
                  />
                  <ProjectRepositories projectId={projectId} />
                  {project.description && (
                    <Card className="border-border/50">
                      <CardContent className="p-4">
                        <p className="text-xs text-muted-foreground leading-relaxed">
                          {project.description}
                        </p>
                        <p className="mt-2 font-mono text-[10px] text-muted-foreground">
                          creado{" "}
                          {formatDistanceToNow(new Date(project.createdAt), {
                            addSuffix: true,
                          })}{" "}
                          · {project._count.features} features
                        </p>
                      </CardContent>
                    </Card>
                  )}
                </ResizablePanel>
              </ResizableGroup>
            </TabsContent>

            {/* Features Tab */}
            <TabsContent value="features">
              <div className="mt-4">
                <FeatureList projectId={projectId} />
              </div>
            </TabsContent>

            {/* Sandboxes Tab */}
            <TabsContent value="sandboxes">
              <ProjectSandboxes
                projectId={projectId}
                onOpenTerminal={(target, label) => {
                  setSshRequest({ target, label, nonce: Date.now() });
                  setProjectTab("terminal");
                }}
                onOpenStack={() => openSetupSection("stack")}
              />
            </TabsContent>

            {/* Terminal Tab */}
            <TabsContent
              value="terminal"
              keepMounted
              className="mt-4 data-[state=inactive]:hidden"
            >
              <Card className="border-border/50">
                <CardHeader>
                  <CardTitle className="text-sm font-medium flex items-center gap-2">
                    <Terminal className="h-4 w-4" />
                    Project Terminal
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="h-[600px] rounded-lg overflow-hidden border p-2">
                    <TerminalManager
                      projectId={projectId}
                      repositories={project.repositories.map((r) => ({
                        id: r.id,
                        name: r.name,
                        localPath: r.localPath,
                        isMain: r.isMain,
                      }))}
                      workspacePath={project.workspacePath ?? null}
                      sshRequest={sshRequest}
                      onSshHandled={() => setSshRequest(null)}
                    />
                  </div>
                </CardContent>
              </Card>
            </TabsContent>
            </div>
          </Tabs>
        </div>
      </div>
    </>
  );
}
