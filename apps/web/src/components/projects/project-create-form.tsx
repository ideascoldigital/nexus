"use client";

// Step 1 of the project wizard: basics + repositories. Extracted from the
// old CreateProjectDialog; same scan/manual modes, but instead of closing a
// dialog it hands the created project to the wizard.

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Plus,
  Trash2,
  Star,
  FolderSearch,
  FolderGit2,
  Check,
  Loader2,
  ArrowLeft,
  Sparkles,
  Palette,
  Server,
  Layers,
  TerminalSquare,
  BrainCircuit,
  Microscope,
  Smartphone,
  Package,
  type LucideIcon,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import type { Project, Repository } from "@nexux/db";
import {
  createProject,
  getProjectDefaults,
  type RepoInput,
} from "@/services/projects";
import { getCredentials } from "@/services/sandbox";
import {
  GIT_PROVIDERS,
  credentialLabel,
  providerOfUrl,
} from "@/lib/git-credentials";
import {
  BOOTSTRAP_TEMPLATES,
  slugifyProjectName,
} from "@/lib/bootstrap/templates";
import { FolderPicker } from "./folder-picker";
import {
  GitHubRepoPicker,
  type PickedGitHubRepo,
} from "@/components/github/github-repo-picker";

// Visual identity per bootstrap template (data stays client-safe in lib).
const BOOTSTRAP_ICONS: Record<string, LucideIcon> = {
  frontend: Palette,
  backend: Server,
  fullstack: Layers,
  scripting: TerminalSquare,
  "data-ai": BrainCircuit,
  research: Microscope,
  mobile: Smartphone,
  library: Package,
};

interface RepoFormEntry extends RepoInput {
  _key: string;
}

interface DiscoveredRepo {
  name: string;
  localPath: string;
  hasGit: boolean;
}

// crypto.randomUUID exists only in secure contexts; a Nexus host is reached
// over plain http on a tailnet IP, where calling it throws and takes the
// whole page down. getRandomValues works everywhere.
function newKey(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function newRepo(isMain = false): RepoFormEntry {
  return {
    _key: newKey(),
    name: "",
    repoUrl: "",
    localPath: "",
    isMain,
    gitCredentialId: "",
  };
}

export function ProjectCreateForm({
  onCreated,
}: {
  onCreated: (project: Project & { repositories: Repository[] }) => void;
}) {
  const queryClient = useQueryClient();

  // Saved git credentials, so a repo added by URL can pick which account
  // clones it — same rule as the repositories tab's Add dialog: until the URL
  // names a host, every git credential is offered rather than none.
  const { data: credentials = [] } = useQuery({
    queryKey: ["credentials"],
    queryFn: getCredentials,
  });
  const credentialsForUrl = (repoUrl?: string) => {
    const provider = providerOfUrl(repoUrl?.trim() || null);
    return credentials.filter((c) =>
      provider ? c.provider === provider : GIT_PROVIDERS.includes(c.provider),
    );
  };

  const [mode, setMode] = useState<
    "choose" | "manual" | "scan" | "bootstrap"
  >("choose");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [repos, setRepos] = useState<RepoFormEntry[]>([newRepo(true)]);

  const [bootstrapType, setBootstrapType] = useState<string | null>(null);
  // Server-chosen: a Nexus host can only write inside its workspace volume,
  // so the suggestion must come from the install, not a client constant.
  const { data: projectDefaults } = useQuery({
    queryKey: ["project-defaults"],
    queryFn: getProjectDefaults,
  });
  const [parentPathEdit, setParentPathEdit] = useState<string | null>(null);
  const parentPath =
    parentPathEdit ?? projectDefaults?.bootstrapParentPath ?? "~/Projects";
  const [parentPickerOpen, setParentPickerOpen] = useState(false);

  const [scanPath, setScanPath] = useState("");
  const [discovered, setDiscovered] = useState<DiscoveredRepo[]>([]);
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set());
  const [isScanning, setIsScanning] = useState(false);
  const [scanError, setScanError] = useState("");
  const [folderPickerOpen, setFolderPickerOpen] = useState(false);

  const mutation = useMutation({
    mutationFn: createProject,
    onSuccess: (project) => {
      queryClient.invalidateQueries({ queryKey: ["projects"] });
      onCreated(project);
    },
  });

  function handleFolderSelect(selectedPath: string) {
    setScanPath(selectedPath);
    doScan(selectedPath);
  }

  async function doScan(dir: string) {
    if (!dir.trim()) return;
    setIsScanning(true);
    setScanError("");
    setDiscovered([]);
    setSelectedPaths(new Set());

    try {
      const res = await fetch("/api/scan-directory", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ directory: dir.trim() }),
      });
      const data = await res.json();
      if (!res.ok) {
        setScanError(data.error || "Scan failed");
        return;
      }
      setDiscovered(data.repos);
      setSelectedPaths(
        new Set(data.repos.map((r: DiscoveredRepo) => r.localPath)),
      );
      if (!name) {
        const dirName = data.directory.split("/").filter(Boolean).pop() || "";
        setName(dirName);
      }
    } catch (err) {
      setScanError(err instanceof Error ? err.message : "Scan failed");
    } finally {
      setIsScanning(false);
    }
  }

  function toggleRepo(localPath: string) {
    setSelectedPaths((prev) => {
      const next = new Set(prev);
      if (next.has(localPath)) next.delete(localPath);
      else next.add(localPath);
      return next;
    });
  }

  function addRepo() {
    setRepos((prev) => [...prev, newRepo()]);
  }

  function removeRepo(key: string) {
    setRepos((prev) => {
      const filtered = prev.filter((r) => r._key !== key);
      if (filtered.length === 0) return [newRepo(true)];
      if (!filtered.some((r) => r.isMain)) filtered[0].isMain = true;
      return filtered;
    });
  }

  function updateRepo(
    key: string,
    field: keyof RepoInput,
    value: string | boolean,
  ) {
    setRepos((prev) =>
      prev.map((r) => {
        if (r._key !== key) {
          if (field === "isMain" && value === true) return { ...r, isMain: false };
          return r;
        }
        return { ...r, [field]: value };
      }),
    );
  }

  // Picking from GitHub fills the URL and, when the row is still unnamed, names
  // it too — one write, so a half-applied row is not a state the form can be in.
  function applyGitHubRepo(key: string, repo: PickedGitHubRepo) {
    setRepos((prev) =>
      prev.map((r) =>
        r._key === key
          ? { ...r, repoUrl: repo.html_url, name: r.name.trim() || repo.name }
          : r,
      ),
    );
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;

    if (mode === "bootstrap") {
      if (!bootstrapType || !parentPath.trim()) return;
      mutation.mutate({
        name: name.trim(),
        description: description.trim() || undefined,
        bootstrap: { type: bootstrapType, parentPath: parentPath.trim() },
      });
      return;
    }

    let repositories: RepoInput[] | undefined;

    if (mode === "scan") {
      const selected = discovered.filter((r) => selectedPaths.has(r.localPath));
      repositories = selected.map((r, i) => ({
        name: r.name,
        localPath: r.localPath,
        isMain: i === 0,
      }));
    } else if (mode === "manual") {
      const valid = repos
        .filter((r) => r.name.trim())
        .map((r) => ({
          name: r.name,
          isMain: r.isMain,
          repoUrl: r.repoUrl || undefined,
          localPath: r.localPath || undefined,
          // Checked against what the picker currently offers: editing the URL
          // to a different host after choosing would otherwise submit a token
          // the clone can never use.
          gitCredentialId:
            r.gitCredentialId &&
            credentialsForUrl(r.repoUrl).some(
              (c) => c.id === r.gitCredentialId,
            )
              ? r.gitCredentialId
              : undefined,
        }));
      repositories = valid.length > 0 ? valid : undefined;
    }

    mutation.mutate({
      name: name.trim(),
      description: description.trim() || undefined,
      workspacePath: mode === "scan" ? scanPath : undefined,
      repositories,
    });
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      {mode === "choose" && (
        <div className="grid grid-cols-3 gap-3 py-2">
          <button
            type="button"
            onClick={() => setMode("bootstrap")}
            className="flex flex-col items-center gap-3 rounded-lg border border-border/50 p-5 hover:border-border hover:bg-muted/30 transition-colors text-center"
          >
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-purple-500/10">
              <Sparkles className="h-5 w-5 text-purple-400" />
            </div>
            <div>
              <p className="text-sm font-medium">Bootstrap Idea</p>
              <p className="text-[11px] text-muted-foreground mt-0.5">
                Start a brand-new project from scratch
              </p>
            </div>
          </button>
          <button
            type="button"
            onClick={() => {
              setMode("scan");
              // Straight into browsing — picking the folder IS this mode's
              // first step, no point making it a second click.
              setFolderPickerOpen(true);
            }}
            className="flex flex-col items-center gap-3 rounded-lg border border-border/50 p-5 hover:border-border hover:bg-muted/30 transition-colors text-center"
          >
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10">
              <FolderSearch className="h-5 w-5 text-primary" />
            </div>
            <div>
              <p className="text-sm font-medium">Scan Directory</p>
              <p className="text-[11px] text-muted-foreground mt-0.5">
                Auto-discover git repos in a folder
              </p>
            </div>
          </button>
          <button
            type="button"
            onClick={() => setMode("manual")}
            className="flex flex-col items-center gap-3 rounded-lg border border-border/50 p-5 hover:border-border hover:bg-muted/30 transition-colors text-center"
          >
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-blue-500/10">
              <Plus className="h-5 w-5 text-blue-400" />
            </div>
            <div>
              <p className="text-sm font-medium">Add Manually</p>
              <p className="text-[11px] text-muted-foreground mt-0.5">
                Enter repo paths and URLs by hand
              </p>
            </div>
          </button>
        </div>
      )}

      {mode === "bootstrap" && (
        <div className="space-y-4">
          <button
            type="button"
            onClick={() => setMode("choose")}
            className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            <ArrowLeft className="h-3 w-3" />
            Back
          </button>

          <div className="grid gap-3">
            <div className="grid gap-1.5">
              <Label className="text-xs">Idea Name</Label>
              <Input
                placeholder="My next big thing"
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="h-8 text-xs w-full"
                required
              />
            </div>
            <div className="grid gap-1.5">
              <Label className="text-xs">What&apos;s the idea? (optional)</Label>
              <Textarea
                placeholder="One or two sentences — this seeds docs/IDEA.md and the Definition step..."
                rows={2}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                className="text-xs w-full"
              />
            </div>
          </div>

          <Separator />

          <div className="space-y-2">
            <Label className="text-xs">Project Type</Label>
            <div className="grid grid-cols-2 gap-2">
              {BOOTSTRAP_TEMPLATES.map((t) => {
                const Icon = BOOTSTRAP_ICONS[t.key] ?? Sparkles;
                const selected = bootstrapType === t.key;
                return (
                  <button
                    key={t.key}
                    type="button"
                    onClick={() => setBootstrapType(t.key)}
                    className={cn(
                      "flex items-start gap-2.5 rounded-lg border p-3 text-left transition-colors",
                      selected
                        ? "border-primary bg-primary/10"
                        : "border-border/50 hover:border-border hover:bg-muted/30",
                    )}
                  >
                    <Icon
                      className={cn(
                        "h-4 w-4 mt-0.5 shrink-0",
                        selected ? "text-primary" : "text-muted-foreground",
                      )}
                    />
                    <div className="min-w-0">
                      <p className="text-xs font-medium">{t.name}</p>
                      <p className="text-[10px] text-muted-foreground mt-0.5 leading-snug">
                        {t.tagline}
                      </p>
                      {t.services.length > 0 && (
                        <div className="flex flex-wrap gap-1 mt-1.5">
                          {t.services.map((s) => (
                            <Badge
                              key={s}
                              variant="outline"
                              className="text-[9px] h-4 px-1 font-mono"
                            >
                              {s}
                            </Badge>
                          ))}
                        </div>
                      )}
                    </div>
                  </button>
                );
              })}
            </div>
            <p className="text-[10px] text-muted-foreground">
              The type seeds the workspace scaffold and pre-wires the Stack
              canvas with the services it needs.
            </p>
          </div>

          <Separator />

          <div className="grid gap-1.5">
            <Label className="text-xs">Location</Label>
            <div className="flex gap-2">
              <Input
                placeholder="~/Projects"
                value={parentPath}
                onChange={(e) => setParentPathEdit(e.target.value)}
                className="h-8 text-xs font-mono flex-1"
              />
              <Button
                type="button"
                size="icon-sm"
                variant="outline"
                onClick={() => setParentPickerOpen(true)}
                title="Browse folders"
              >
                <FolderSearch className="h-3.5 w-3.5" />
              </Button>
            </div>
            {name.trim() && parentPath.trim() && (
              <p className="text-[10px] text-muted-foreground font-mono">
                Will create {parentPath.replace(/\/+$/, "")}/
                {slugifyProjectName(name) || "…"} (git initialized)
              </p>
            )}
          </div>

          <FolderPicker
            open={parentPickerOpen}
            onOpenChange={setParentPickerOpen}
            onSelect={(p) => setParentPathEdit(p)}
            initialPath={parentPath || "~"}
          />
        </div>
      )}

      {mode === "scan" && (
        <div className="space-y-4">
          <button
            type="button"
            onClick={() => setMode("choose")}
            className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            <ArrowLeft className="h-3 w-3" />
            Back
          </button>

          <div className="flex gap-2">
            <Input
              placeholder="~/Projects/cris or /absolute/path"
              value={scanPath}
              onChange={(e) => setScanPath(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  doScan(scanPath);
                }
              }}
              className="h-8 text-xs font-mono flex-1"
            />
            <Button
              type="button"
              size="icon-sm"
              variant="outline"
              onClick={() => setFolderPickerOpen(true)}
              title="Browse folders"
            >
              <FolderSearch className="h-3.5 w-3.5" />
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => doScan(scanPath)}
              disabled={isScanning || !scanPath.trim()}
              className="gap-1.5"
            >
              {isScanning ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                "Scan"
              )}
            </Button>
          </div>

          <FolderPicker
            open={folderPickerOpen}
            onOpenChange={setFolderPickerOpen}
            onSelect={handleFolderSelect}
            initialPath={scanPath || "~"}
          />

          {scanError && <p className="text-xs text-destructive">{scanError}</p>}

          {discovered.length > 0 && (
            <>
              <div className="flex items-center justify-between">
                <span className="text-xs text-muted-foreground">
                  Found {discovered.length} repo
                  {discovered.length !== 1 ? "s" : ""}
                </span>
                <button
                  type="button"
                  onClick={() => {
                    if (selectedPaths.size === discovered.length) {
                      setSelectedPaths(new Set());
                    } else {
                      setSelectedPaths(
                        new Set(discovered.map((r) => r.localPath)),
                      );
                    }
                  }}
                  className="text-[11px] text-muted-foreground hover:text-foreground transition-colors"
                >
                  {selectedPaths.size === discovered.length
                    ? "Deselect all"
                    : "Select all"}
                </button>
              </div>

              <ScrollArea className="h-[220px] -mx-1 px-1">
                <div className="space-y-1">
                  {discovered.map((repo) => (
                    <button
                      key={repo.localPath}
                      type="button"
                      onClick={() => toggleRepo(repo.localPath)}
                      className={cn(
                        "w-full flex items-center gap-2.5 rounded-md px-2.5 py-2 text-left transition-colors",
                        selectedPaths.has(repo.localPath)
                          ? "bg-primary/10"
                          : "hover:bg-muted/50",
                      )}
                    >
                      <div
                        className={cn(
                          "flex h-4 w-4 shrink-0 items-center justify-center rounded border transition-colors",
                          selectedPaths.has(repo.localPath)
                            ? "bg-primary border-primary"
                            : "border-border",
                        )}
                      >
                        {selectedPaths.has(repo.localPath) && (
                          <Check className="h-3 w-3 text-primary-foreground" />
                        )}
                      </div>
                      <FolderGit2 className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                      <div className="min-w-0 flex-1">
                        <p className="text-xs font-medium">{repo.name}</p>
                        <p className="text-[10px] text-muted-foreground font-mono truncate">
                          {repo.localPath}
                        </p>
                      </div>
                    </button>
                  ))}
                </div>
              </ScrollArea>

              <Separator />

              <div className="grid gap-3">
                <div className="grid gap-1.5">
                  <Label className="text-xs">Project Name</Label>
                  <Input
                    placeholder="Project name"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    className="h-8 text-xs w-full"
                    required
                  />
                </div>
                <div className="grid gap-1.5">
                  <Label className="text-xs">Description (optional)</Label>
                  <Textarea
                    placeholder="Brief description..."
                    rows={2}
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    className="text-xs w-full"
                  />
                </div>
              </div>
            </>
          )}
        </div>
      )}

      {mode === "manual" && (
        <div className="space-y-4">
          <button
            type="button"
            onClick={() => setMode("choose")}
            className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            <ArrowLeft className="h-3 w-3" />
            Back
          </button>

          <div className="grid gap-3">
            <div className="grid gap-1.5">
              <Label className="text-xs">Project Name</Label>
              <Input
                placeholder="My Awesome Project"
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="h-8 text-xs w-full"
                required
              />
            </div>
            <div className="grid gap-1.5">
              <Label className="text-xs">Description (optional)</Label>
              <Textarea
                placeholder="Brief description..."
                rows={2}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                className="text-xs"
              />
            </div>
          </div>

          <Separator />

          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <Label className="text-xs">Repositories</Label>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={addRepo}
                className="gap-1 h-6 text-[11px]"
              >
                Add Repo
              </Button>
            </div>

            {repos.map((repo) => (
              <div
                key={repo._key}
                className="rounded-lg border border-border/50 p-3 space-y-2"
              >
                <div className="flex items-center gap-2">
                  <Input
                    placeholder="Repo name (e.g. frontend, api)"
                    value={repo.name}
                    onChange={(e) =>
                      updateRepo(repo._key, "name", e.target.value)
                    }
                    className="h-7 text-xs flex-1"
                  />
                  <button
                    type="button"
                    onClick={() => updateRepo(repo._key, "isMain", !repo.isMain)}
                    className={cn(
                      "shrink-0 p-1 rounded transition-colors",
                      repo.isMain
                        ? "text-amber-400"
                        : "text-muted-foreground/30 hover:text-muted-foreground",
                    )}
                  >
                    <Star
                      className="h-3.5 w-3.5"
                      fill={repo.isMain ? "currentColor" : "none"}
                    />
                  </button>
                  {repos.length > 1 && (
                    <button
                      type="button"
                      onClick={() => removeRepo(repo._key)}
                      className="shrink-0 p-1 text-muted-foreground/50 hover:text-destructive transition-colors"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>
                <Input
                  placeholder="Local path: /home/user/projects/repo"
                  value={repo.localPath}
                  onChange={(e) =>
                    updateRepo(repo._key, "localPath", e.target.value)
                  }
                  className="h-7 text-xs font-mono"
                />
                <div className="flex gap-1.5">
                  <Input
                    placeholder="Git URL (optional): https://github.com/user/repo"
                    value={repo.repoUrl}
                    onChange={(e) =>
                      updateRepo(repo._key, "repoUrl", e.target.value)
                    }
                    className="h-7 text-xs flex-1"
                  />
                  <GitHubRepoPicker
                    onSelect={(picked) => applyGitHubRepo(repo._key, picked)}
                  />
                </div>
                {/* Which account clones this repo. Offered up front like the
                    repositories tab's Add dialog: with several tokens the
                    automatic pick is a coin toss, and getting it wrong looks
                    like a broken repository. */}
                {(() => {
                  const options = credentialsForUrl(repo.repoUrl);
                  return (
                    <select
                      value={repo.gitCredentialId ?? ""}
                      onChange={(e) =>
                        updateRepo(repo._key, "gitCredentialId", e.target.value)
                      }
                      disabled={options.length === 0}
                      className="h-7 w-full rounded-md border border-input bg-transparent px-2 text-xs text-muted-foreground disabled:opacity-60"
                      title="Git credential this repository is cloned with"
                    >
                      <option value="">
                        {options.length === 0
                          ? "No git credentials saved — add one in Settings → Git"
                          : `Automatic (${credentialLabel(options[0])})`}
                      </option>
                      {options.map((c) => (
                        <option key={c.id} value={c.id}>
                          {credentialLabel(c)}
                        </option>
                      ))}
                    </select>
                  );
                })()}
                {repo.isMain && (
                  <Badge
                    variant="outline"
                    className="text-[9px] h-4 bg-amber-500/10 text-amber-400 border-amber-500/20"
                  >
                    Main — working directory for conversations
                  </Badge>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {mutation.isError && (
        <p className="text-xs text-destructive">{mutation.error.message}</p>
      )}

      {mode !== "choose" && (
        <div className="flex justify-end">
          <Button
            type="submit"
            disabled={
              mutation.isPending ||
              !name.trim() ||
              (mode === "scan" && selectedPaths.size === 0) ||
              (mode === "bootstrap" &&
                (!bootstrapType || !parentPath.trim()))
            }
          >
            {mutation.isPending
              ? "Creating..."
              : mode === "scan"
                ? `Create with ${selectedPaths.size} repo${selectedPaths.size !== 1 ? "s" : ""}`
                : mode === "bootstrap"
                  ? "Bootstrap Project"
                  : "Create Project"}
          </Button>
        </div>
      )}
    </form>
  );
}
