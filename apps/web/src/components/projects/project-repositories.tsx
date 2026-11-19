"use client";

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  DialogFooter,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Download,
  ExternalLink,
  FolderGit2,
  FolderOpen,
  FolderSearch,
  KeyRound,
  Loader2,
  RefreshCw,
  Star,
  Trash2,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  getRepositories,
  addRepository,
  cloneProjectRepositories,
  cloneRepository,
  deleteRepository,
  updateRepository,
  type RepoInput,
} from "@/services/projects";
import {
  getCredentials,
  type CloudCredentialSummary,
} from "@/services/sandbox";
import type { Repository } from "@nexux/db";
import type { CloneStatus } from "@/types";
import { FolderPicker } from "./folder-picker";
import {
  GitHubRepoPicker,
  type PickedGitHubRepo,
} from "@/components/github/github-repo-picker";
import {
  GIT_PROVIDERS,
  credentialLabel,
  providerOfUrl,
} from "@/lib/git-credentials";

const cloneStatusConfig: Record<
  CloneStatus,
  { label: string; className: string }
> = {
  ready: {
    label: "Ready",
    className: "bg-emerald-500/10 text-emerald-400 border-emerald-500/20",
  },
  cloning: {
    label: "Cloning",
    className: "bg-yellow-500/10 text-yellow-400 border-yellow-500/20",
  },
  pending: {
    label: "Pending",
    className: "bg-muted text-muted-foreground border-border",
  },
  error: {
    label: "Error",
    className: "bg-red-500/10 text-red-400 border-red-500/20",
  },
};

function AddRepoDialog({ projectId }: { projectId: string }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [repoUrl, setRepoUrl] = useState("");
  const [localPath, setLocalPath] = useState("");
  const [gitCredentialId, setGitCredentialId] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);
  const queryClient = useQueryClient();

  const { data: credentials = [] } = useQuery({
    queryKey: ["credentials"],
    queryFn: getCredentials,
  });
  // Narrowed to the host being typed once the URL names one, because only that
  // host's tokens can clone it. Before then every git credential is offered
  // rather than none: this form creates the repo and chooses its account in one
  // step, so a field that is absent until the URL parses reads as a missing
  // feature — and the choice still has to be made either way.
  const addProvider = providerOfUrl(repoUrl.trim() || null);
  const addCredentials = credentials.filter((c) =>
    addProvider ? c.provider === addProvider : GIT_PROVIDERS.includes(c.provider),
  );

  function handleFolderSelect(selected: string) {
    setLocalPath(selected);
    if (!name.trim()) {
      const base = selected.split("/").filter(Boolean).pop() || "";
      setName(base);
    }
  }

  // Mirrors handleFolderSelect: fill the field that was asked for, and name the
  // repo only if nothing has been typed — a name already entered is a decision,
  // not a placeholder.
  function handleGitHubRepoSelect(repo: PickedGitHubRepo) {
    setRepoUrl(repo.html_url);
    if (!name.trim()) setName(repo.name);
  }

  const mutation = useMutation({
    mutationFn: (data: RepoInput) => addRepository(projectId, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["repositories", projectId] });
      queryClient.invalidateQueries({ queryKey: ["project", projectId] });
      queryClient.invalidateQueries({ queryKey: ["projects"] });
      setOpen(false);
      setName("");
      setRepoUrl("");
      setLocalPath("");
      setGitCredentialId("");
    },
  });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        nativeButton={true}
        render={
          <Button variant="outline" size="sm" className="gap-1.5">
            Add Repo
          </Button>
        }
      />
      <DialogContent className="sm:max-w-md">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!name.trim()) return;
            mutation.mutate({
              name: name.trim(),
              repoUrl: repoUrl.trim() || undefined,
              localPath: localPath.trim() || undefined,
              // Checked against what the field currently offers: editing the URL
              // to a different host after choosing would otherwise submit a
              // token the clone can never use. A pick made before the URL named
              // a provider survives, since the list is then every git
              // credential rather than none.
              gitCredentialId:
                gitCredentialId &&
                addCredentials.some((c) => c.id === gitCredentialId)
                  ? gitCredentialId
                  : undefined,
            });
          }}
        >
          <DialogHeader>
            <DialogTitle>Add Repository</DialogTitle>
          </DialogHeader>
          <div className="grid gap-3 py-4">
            <div className="grid gap-1.5">
              <Label className="text-xs">Name</Label>
              <Input
                placeholder="e.g. frontend, api, infra"
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="h-8 text-xs"
                required
              />
            </div>
            <div className="grid gap-1.5">
              <Label className="text-xs">Local Path</Label>
              <div className="flex gap-2">
                <Input
                  placeholder="/home/user/projects/repo"
                  value={localPath}
                  onChange={(e) => setLocalPath(e.target.value)}
                  className="h-8 text-xs font-mono flex-1"
                />
                <Button
                  type="button"
                  size="icon-sm"
                  variant="outline"
                  onClick={() => setPickerOpen(true)}
                  title="Browse folders"
                >
                  <FolderSearch className="h-3.5 w-3.5" />
                </Button>
              </div>
            </div>
            <FolderPicker
              open={pickerOpen}
              onOpenChange={setPickerOpen}
              onSelect={handleFolderSelect}
              initialPath={localPath || "~"}
            />
            <div className="grid gap-1.5">
              <Label className="text-xs">Git URL</Label>
              {/* Typed or picked — same field either way. The picker only
                  appears when a GitHub account is connected, and it fills this
                  input rather than replacing it, so any other host still works
                  by hand. */}
              <div className="flex gap-2">
                <Input
                  placeholder="https://github.com/user/repo"
                  value={repoUrl}
                  onChange={(e) => setRepoUrl(e.target.value)}
                  className="h-8 text-xs flex-1"
                />
                <GitHubRepoPicker onSelect={handleGitHubRepoSelect} />
              </div>
            </div>
            {/* Always shown, even with a single token: this form creates the
                repo and picks its account in one step, so the choice has to be
                offered up front. Asking here rather than after the first failed
                clone — with several accounts the automatic pick is a coin toss,
                and getting it wrong looks like a broken repository. */}
            <div className="grid gap-1.5">
              <Label className="text-xs">Git credential</Label>
              <select
                value={gitCredentialId}
                onChange={(e) => setGitCredentialId(e.target.value)}
                disabled={addCredentials.length === 0}
                className="h-8 rounded-md border border-input bg-transparent px-2 text-xs disabled:opacity-60"
              >
                <option value="">
                  {addCredentials.length === 0
                    ? "No git credentials saved — add one in Settings → Git"
                    : `Automatic (${credentialLabel(addCredentials[0])})`}
                </option>
                {addCredentials.map((c) => (
                  <option key={c.id} value={c.id}>
                    {credentialLabel(c)}
                  </option>
                ))}
              </select>
            </div>
          </div>
          {mutation.isError && (
            <p className="text-xs text-destructive pb-3">
              {mutation.error.message}
            </p>
          )}
          <DialogFooter>
            <Button type="submit" size="sm" disabled={mutation.isPending}>
              {mutation.isPending ? "Adding..." : "Add"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function RepoRow({
  repo,
  projectId,
  credentials,
}: {
  repo: Repository;
  projectId: string;
  /** Every saved git credential, fetched once by the parent. */
  credentials: CloudCredentialSummary[];
}) {
  const queryClient = useQueryClient();
  const statusConfig =
    cloneStatusConfig[(repo.cloneStatus as CloneStatus) ?? "pending"];

  // Only credentials for this remote's host can authenticate it, so offering
  // the rest would be offering choices that cannot work.
  const provider = providerOfUrl(repo.repoUrl);
  const gitCredentials = provider
    ? credentials.filter((c) => c.provider === provider)
    : [];
  // What "Automatic" resolves to today — the same first-saved rule the server
  // applies, so the label names the token that will actually be used.
  const defaultCredentialName = gitCredentials[0]
    ? credentialLabel(gitCredentials[0])
    : null;

  const setCredentialMutation = useMutation({
    mutationFn: (gitCredentialId: string | null) =>
      updateRepository(projectId, repo.id, { gitCredentialId }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["repositories", projectId] });
      queryClient.invalidateQueries({ queryKey: ["project", projectId] });
    },
  });

  const setMainMutation = useMutation({
    mutationFn: () =>
      updateRepository(projectId, repo.id, { isMain: true }),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ["repositories", projectId],
      });
      queryClient.invalidateQueries({ queryKey: ["project", projectId] });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: () => deleteRepository(projectId, repo.id),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ["repositories", projectId],
      });
      queryClient.invalidateQueries({ queryKey: ["project", projectId] });
      queryClient.invalidateQueries({ queryKey: ["projects"] });
    },
  });

  // Check the repo out on this machine, or pull it when it is already there.
  // The status the row shows is written by the server, so the row and the disk
  // cannot disagree.
  const cloneMutation = useMutation({
    mutationFn: (sync: boolean = false) =>
      cloneRepository(projectId, repo.id, { sync }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["repositories", projectId] });
      queryClient.invalidateQueries({ queryKey: ["project", projectId] });
      queryClient.invalidateQueries({ queryKey: ["projects"] });
    },
  });

  // Fill repoUrl from the local checkout's origin remote — makes the repo
  // cloneable on sandboxes without typing the URL.
  const detectUrlMutation = useMutation({
    mutationFn: () =>
      updateRepository(projectId, repo.id, { detectRepoUrl: true }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["repositories", projectId] });
      queryClient.invalidateQueries({ queryKey: ["project", projectId] });
      queryClient.invalidateQueries({ queryKey: ["project-setup", projectId] });
    },
  });

  return (
    <div className="flex items-start gap-3 rounded-lg border border-border/50 p-3">
      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-muted/50">
        <FolderGit2 className="h-3.5 w-3.5 text-muted-foreground" />
      </div>
      <div className="min-w-0 flex-1 space-y-1.5">
        {/* Wraps as a unit: in a narrow rail a long name used to break onto
            two lines while its badges sat vertically centred beside it. Now
            the badges follow the name, or drop to the next line together. */}
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="min-w-0 break-words text-sm font-medium">{repo.name}</span>
          {repo.isMain && (
            <Badge
              variant="outline"
              className="shrink-0 text-[9px] h-4 bg-amber-500/10 text-amber-400 border-amber-500/20"
            >
              main
            </Badge>
          )}
          <Badge
            variant="outline"
            className={cn("shrink-0 text-[9px] h-4", statusConfig.className)}
          >
            {statusConfig.label}
          </Badge>
        </div>
        {repo.localPath && (
          <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <FolderOpen className="h-3 w-3 shrink-0" />
            <code className="truncate">{repo.localPath}</code>
          </div>
        )}
        {repo.repoUrl && (
          <div className="flex items-center gap-1.5 text-[11px]">
            <ExternalLink className="h-3 w-3 shrink-0 text-muted-foreground" />
            <a
              href={repo.repoUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-blue-400 hover:underline truncate"
            >
              {repo.repoUrl}
            </a>
          </div>
        )}
        {!repo.repoUrl && repo.localPath && (
          <div className="space-y-1">
            <button
              onClick={() => detectUrlMutation.mutate()}
              disabled={detectUrlMutation.isPending}
              className="flex items-center gap-1.5 text-[11px] text-amber-400/90 hover:text-amber-300 transition-colors"
              title="Read the checkout's origin remote and save it as the clone URL"
            >
              {detectUrlMutation.isPending && <Loader2 className="h-3 w-3 shrink-0 animate-spin" />}
              no clone URL — detect from git remote
            </button>
            {detectUrlMutation.isError && (
              <p className="text-[11px] text-destructive">
                {(detectUrlMutation.error as Error).message}
              </p>
            )}
          </div>
        )}
        {/* Which account to clone as. Shown whenever the remote names a host we
            hold any token for — including a single one, so the row always says
            which credential it will use rather than leaving it implicit. Two
            tokens for the same host is where it matters most: the automatic
            pick is right for one account and cannot see the other's private
            repos, and that failure is indistinguishable from a broken repo. */}
        {gitCredentials.length > 0 && (
          <div className="flex items-center gap-1.5 text-[11px]">
            <KeyRound className="h-3 w-3 shrink-0 text-muted-foreground" />
            <select
              value={repo.gitCredentialId ?? ""}
              onChange={(e) =>
                setCredentialMutation.mutate(e.target.value || null)
              }
              disabled={setCredentialMutation.isPending}
              className="bg-transparent text-muted-foreground hover:text-foreground outline-none cursor-pointer max-w-[280px] truncate"
              title="Git credential this repository is cloned and pulled with"
            >
              <option value="">
                {defaultCredentialName
                  ? `Automatic (${defaultCredentialName})`
                  : "Automatic"}
              </option>
              {gitCredentials.map((c) => (
                <option key={c.id} value={c.id}>
                  {credentialLabel(c)}
                </option>
              ))}
            </select>
            {setCredentialMutation.isPending && (
              <Loader2 className="h-3 w-3 shrink-0 animate-spin" />
            )}
          </div>
        )}
        {/* What happened — git's own words on failure, minus anything
            token-shaped, and the new HEAD on a successful sync. Without this a
            sync that did nothing looks identical to one that pulled. */}
        {(cloneMutation.data || cloneMutation.isError) && (
          <p
            className={cn(
              "text-[11px]",
              cloneMutation.data?.status === "ready"
                ? "text-muted-foreground"
                : "text-destructive",
            )}
          >
            {cloneMutation.data?.message ??
              (cloneMutation.error as Error)?.message}
          </p>
        )}
      </div>
      <div className="flex items-center gap-1 shrink-0">
        {/* Two verbs, one button position: get the code when it is missing,
            update it when it is there. Both need somewhere to pull from. */}
        {repo.repoUrl && (
          <button
            onClick={() => cloneMutation.mutate(repo.cloneStatus === "ready")}
            disabled={cloneMutation.isPending || repo.cloneStatus === "cloning"}
            title={
              !repo.localPath
                ? "Set a local path first"
                : repo.cloneStatus === "ready"
                  ? "Pull the latest commits"
                  : `Clone into ${repo.localPath}`
            }
            className="p-1 text-muted-foreground/50 hover:text-foreground transition-colors disabled:opacity-40"
          >
            {cloneMutation.isPending || repo.cloneStatus === "cloning" ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : repo.cloneStatus === "ready" ? (
              <RefreshCw className="h-3.5 w-3.5" />
            ) : (
              <Download className="h-3.5 w-3.5" />
            )}
          </button>
        )}
        {!repo.isMain && (
          <button
            onClick={() => setMainMutation.mutate()}
            title="Set as main"
            className="p-1 text-muted-foreground/30 hover:text-amber-400 transition-colors"
          >
            <Star className="h-3.5 w-3.5" />
          </button>
        )}
        <button
          onClick={() => deleteMutation.mutate()}
          title="Remove"
          className="p-1 text-muted-foreground/30 hover:text-destructive transition-colors"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}

export function ProjectRepositories({ projectId }: { projectId: string }) {
  const queryClient = useQueryClient();
  const { data: repos = [] } = useQuery({
    queryKey: ["repositories", projectId],
    queryFn: () => getRepositories(projectId),
  });

  // Fetched once for the whole list rather than per row — every row filters the
  // same set down to its own remote's provider.
  const { data: credentials = [] } = useQuery({
    queryKey: ["credentials"],
    queryFn: getCredentials,
  });

  // The case this exists for: an install that was just imported onto another
  // machine, where every repo has a URL and a path and no working copy.
  const cloneAll = useMutation({
    mutationFn: (sync: boolean = false) =>
      cloneProjectRepositories(projectId, { sync }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["repositories", projectId] });
      queryClient.invalidateQueries({ queryKey: ["project", projectId] });
      queryClient.invalidateQueries({ queryKey: ["projects"] });
    },
  });

  const cloneable = repos.filter((r) => r.repoUrl);
  const missing = cloneable.filter((r) => r.cloneStatus !== "ready").length;
  const failed = cloneAll.data?.filter((r) => r.status === "error") ?? [];
  // Reported on success too: a sync that pulled nothing and one that pulled
  // three commits look the same without it.
  const updated = cloneAll.data?.filter((r) => r.status === "ready") ?? [];

  return (
    <Card className="border-border/50">
      {/* Wraps rather than overflows: this card lives in a resizable rail
          that can be dragged down to 18% of the page, where the title and
          three buttons no longer fit on one line — and a row that cannot
          shrink pushes "Add Repo" off the card's edge. */}
      <CardHeader className="pb-3 flex flex-row flex-wrap items-center justify-between gap-2">
        <CardTitle className="text-sm font-medium flex min-w-0 items-center gap-2">
          <FolderGit2 className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span className="whitespace-nowrap">Repositories ({repos.length})</span>
        </CardTitle>
        <div className="flex flex-wrap items-center gap-2">
          {missing > 0 && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => cloneAll.mutate(false)}
              disabled={cloneAll.isPending}
            >
              {cloneAll.isPending ? (
                <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
              ) : (
                <Download className="h-3.5 w-3.5 mr-1.5" />
              )}
              Clone {missing}
            </Button>
          )}
          {cloneable.length > 0 && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => cloneAll.mutate(true)}
              disabled={cloneAll.isPending}
              title="Clone what is missing and pull what is already here"
            >
              {cloneAll.isPending ? (
                <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
              ) : (
                <RefreshCw className="h-3.5 w-3.5 mr-1.5" />
              )}
              Sync
            </Button>
          )}
          <AddRepoDialog projectId={projectId} />
        </div>
      </CardHeader>
      <CardContent>
        {repos.length === 0 ? (
          <p className="text-xs text-muted-foreground/60 py-6 text-center">
            No repositories. Add one to connect your codebase.
          </p>
        ) : (
          <div className="space-y-2">
            {repos.map((repo) => (
              <RepoRow
                key={repo.id}
                repo={repo}
                projectId={projectId}
                credentials={credentials}
              />
            ))}
          </div>
        )}
        {/* Partial success is the normal outcome — one private repo with no
            token among several public ones — so every repo is named rather
            than reduced to a count. */}
        {(failed.length > 0 || updated.length > 0) && (
          <div className="mt-3 space-y-1">
            {failed.map((f) => (
              <p key={f.repoId} className="text-[11px] text-destructive">
                <span className="font-medium">{f.name}</span>: {f.message}
              </p>
            ))}
            {updated.map((u) => (
              <p key={u.repoId} className="text-[11px] text-muted-foreground">
                <span className="font-medium">{u.name}</span>: {u.message}
              </p>
            ))}
          </div>
        )}
        {cloneAll.isError && (
          <p className="mt-3 text-[11px] text-destructive">
            {(cloneAll.error as Error).message}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
