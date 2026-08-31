"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { BrandIcon } from "@/components/ui/brand-icon";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import {
  AlertCircle,
  CheckCircle,
  ExternalLink,
  Loader2,
  Plus,
  RefreshCw,
  Trash2,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { type GitLabAccount, instanceHost } from "./gitlab-shared";

interface SavedCredential {
  id: string;
  name: string;
  provider: string;
  hint: string;
}

const DEFAULT_BASE_URL = "https://gitlab.com";

function AddServerDialog({ onSuccess }: { onSuccess: () => void }) {
  const [open, setOpen] = useState(false);
  const [baseUrl, setBaseUrl] = useState(DEFAULT_BASE_URL);
  const [label, setLabel] = useState("");
  // "" means "paste a token instead" — the fallback for anyone who has not
  // saved a GitLab credential yet.
  const [credentialId, setCredentialId] = useState("");
  const [pat, setPat] = useState("");
  const { toast } = useToast();

  const { data: credentials = [] } = useQuery<SavedCredential[]>({
    queryKey: ["cloud-credentials"],
    queryFn: async () => {
      const res = await fetch("/api/credentials");
      if (!res.ok) throw new Error("Failed to load credentials");
      return res.json();
    },
    enabled: open,
    select: (all) => all.filter((c) => c.provider === "gitlab"),
  });

  const usingPat = credentialId === "";

  const mutation = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/gitlab/accounts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          baseUrl,
          label,
          ...(usingPat ? { pat } : { credentialId }),
        }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(
          typeof err.error === "string" ? err.error : "Failed to add server",
        );
      }
      // 201 created a server, 200 re-registered one that was already there.
      return { account: await res.json(), created: res.status === 201 };
    },
    onSuccess: ({ account, created }) => {
      toast({
        title: created
          ? "GitLab server connected"
          : `Updated the existing server for ${account.label}`,
        description: created
          ? undefined
          : "That instance and token were already registered, so the entry was refreshed instead of duplicated.",
      });
      setOpen(false);
      setBaseUrl(DEFAULT_BASE_URL);
      setLabel("");
      setCredentialId("");
      setPat("");
      onSuccess();
    },
    onError: (err: Error) => {
      toast({
        title: "Could not connect",
        description: err.message,
        variant: "destructive",
      });
    },
  });

  // The token-creation deep link has to point at *this* instance, not
  // gitlab.com — a self-hosted user sent to gitlab.com mints a token that will
  // never authenticate against their server.
  const tokenUrl = (() => {
    try {
      return `${new URL(baseUrl.trim() || DEFAULT_BASE_URL).origin}/-/user_settings/personal_access_tokens?name=Nexus%20issues&scopes=read_api`;
    } catch {
      return null;
    }
  })();

  const filled =
    baseUrl.trim() && label.trim() && (usingPat ? pat.trim() : credentialId);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger nativeButton render={<Button size="sm" />}>
        <Plus className="h-4 w-4 mr-1.5" />
        Add Server
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <BrandIcon brand="gitlab" className="h-5 w-5" />
            Connect a GitLab server
          </DialogTitle>
          <DialogDescription>
            Point Nexus at gitlab.com or any self-hosted instance. A GitLab
            credential you already saved for cloning works as-is — it needs the{" "}
            <code className="text-xs bg-muted px-1 py-0.5 rounded">
              read_api
            </code>{" "}
            scope to read issues.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="space-y-2">
            <Label htmlFor="gitlab-url">Instance URL</Label>
            <Input
              id="gitlab-url"
              placeholder="https://gitlab.example.com"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              className="font-mono text-xs"
              autoComplete="off"
            />
            <p className="text-xs text-muted-foreground">
              The address you open in a browser. Paths and a trailing{" "}
              <code className="text-[10px]">/api/v4</code> are trimmed for you.
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="gitlab-label">Label</Label>
            <Input
              id="gitlab-label"
              placeholder="e.g. Work GitLab, gitlab.com"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="gitlab-credential">Token</Label>
            <Select
              value={credentialId}
              onValueChange={(v) => setCredentialId(v ?? "")}
            >
              <SelectTrigger id="gitlab-credential">
                <SelectValue placeholder="Paste a token instead">
                  {(v: unknown) =>
                    credentials.find((c) => c.id === v)?.name ??
                    "Paste a token instead"
                  }
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="">Paste a token instead</SelectItem>
                {credentials.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.name}
                    <span className="text-muted-foreground ml-1">{c.hint}</span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {credentials.length === 0 && (
              <p className="text-xs text-muted-foreground">
                No saved GitLab credentials yet — add one under Cloud &amp; Git
                credentials to reuse it here.
              </p>
            )}
          </div>

          {usingPat && (
            <div className="space-y-2">
              <Label htmlFor="gitlab-pat">Personal Access Token</Label>
              <Input
                id="gitlab-pat"
                type="password"
                placeholder="glpat-xxxxxxxxxxxxxxxxxxxx"
                value={pat}
                onChange={(e) => setPat(e.target.value)}
                autoComplete="off"
              />
              <p className="text-xs text-muted-foreground">
                Stored locally and never sent anywhere but this instance.
                {tokenUrl && (
                  <>
                    {" "}
                    <a
                      href={tokenUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 text-primary hover:underline"
                    >
                      Create one
                      <ExternalLink className="h-3 w-3" />
                    </a>
                  </>
                )}
              </p>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button
            onClick={() => mutation.mutate()}
            disabled={!filled || mutation.isPending}
          >
            {mutation.isPending && (
              <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />
            )}
            Connect
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ServerRow({ account }: { account: GitLabAccount }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const refreshMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/gitlab/accounts/${account.id}`, {
        method: "PATCH",
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Validation failed");
      }
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Server re-validated" });
      queryClient.invalidateQueries({ queryKey: ["gitlab-accounts"] });
    },
    onError: (err: Error) => {
      toast({
        title: "Error",
        description: err.message,
        variant: "destructive",
      });
      queryClient.invalidateQueries({ queryKey: ["gitlab-accounts"] });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/gitlab/accounts/${account.id}`, {
        method: "DELETE",
      });
      if (!res.ok) throw new Error("Failed to remove server");
    },
    onSuccess: () => {
      toast({ title: "Server removed" });
      queryClient.invalidateQueries({ queryKey: ["gitlab-accounts"] });
    },
    onError: (err: Error) => {
      toast({
        title: "Error",
        description: err.message,
        variant: "destructive",
      });
    },
  });

  const meta = account.metadata;
  const isConnected = account.status === "connected";

  return (
    <div className="flex items-center gap-4 py-3">
      <Avatar className="h-9 w-9">
        <AvatarImage src={meta?.avatar_url ?? undefined} alt={meta?.username} />
        <AvatarFallback>
          <BrandIcon brand="gitlab" className="h-4 w-4" />
        </AvatarFallback>
      </Avatar>

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-medium text-sm">{account.label}</span>
          {meta?.web_url && meta.username && (
            <a
              href={meta.web_url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1"
            >
              @{meta.username}
              <ExternalLink className="h-3 w-3" />
            </a>
          )}
          <Badge
            variant={isConnected ? "secondary" : "destructive"}
            className="text-xs"
          >
            {isConnected ? (
              <CheckCircle className="h-3 w-3 mr-1" />
            ) : (
              <AlertCircle className="h-3 w-3 mr-1" />
            )}
            {account.status}
          </Badge>
        </div>
        <p className="text-xs text-muted-foreground truncate">
          {instanceHost(account)}
          {meta?.credentialId ? " · saved credential" : " · pasted token"}
        </p>
      </div>

      <div className="flex items-center gap-1 shrink-0">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => refreshMutation.mutate()}
          disabled={refreshMutation.isPending}
          title="Re-validate token"
        >
          {refreshMutation.isPending ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <RefreshCw className="h-4 w-4" />
          )}
        </Button>

        <AlertDialog>
          <AlertDialogTrigger
            nativeButton
            render={
              <Button
                variant="ghost"
                size="sm"
                disabled={deleteMutation.isPending}
              />
            }
          >
            <Trash2 className="h-4 w-4 text-destructive" />
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Remove GitLab server?</AlertDialogTitle>
              <AlertDialogDescription>
                This removes <strong>{account.label}</strong> and its cached
                issues. Features already imported from it stay, but lose the
                link back to the issue they came from. A saved credential this
                server borrows its token from is not touched.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                onClick={() => deleteMutation.mutate()}
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              >
                Remove
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    </div>
  );
}

export function GitLabServersSection() {
  const queryClient = useQueryClient();

  const { data: accounts = [], isLoading } = useQuery<GitLabAccount[]>({
    queryKey: ["gitlab-accounts"],
    queryFn: async () => {
      const res = await fetch("/api/gitlab/accounts");
      if (!res.ok) throw new Error("Failed to load GitLab servers");
      return res.json();
    },
  });

  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: ["gitlab-accounts"] });

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="flex items-center gap-2">
              <BrandIcon brand="gitlab" className="h-5 w-5" />
              GitLab Servers
            </CardTitle>
            <CardDescription className="mt-1">
              gitlab.com and self-hosted instances, each with its own URL and
              token, to import issues into your projects.
            </CardDescription>
          </div>
          <AddServerDialog onSuccess={refresh} />
        </div>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground py-4">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading servers...
          </div>
        ) : accounts.length === 0 ? (
          <div className="py-8 text-center">
            <BrandIcon
              brand="gitlab"
              className="h-10 w-10 mx-auto text-muted-foreground/40 mb-3"
            />
            <p className="text-sm text-muted-foreground">
              No GitLab servers connected yet.
            </p>
            <p className="text-xs text-muted-foreground mt-1">
              Add one to start importing issues.
            </p>
          </div>
        ) : (
          <div className="divide-y">
            {accounts.map((account) => (
              <ServerRow key={account.id} account={account} />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
