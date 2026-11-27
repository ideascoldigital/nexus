"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
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
  GitBranch,
  Plus,
  Trash2,
  CheckCircle,
  AlertCircle,
  ExternalLink,
  Loader2,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";

interface GitHubAccount {
  id: string;
  label: string;
  status: string;
  lastCheckedAt: string | null;
  metadata: {
    login: string;
    name: string | null;
    avatar_url: string;
    email: string | null;
  } | null;
}

function AddAccountDialog({ onSuccess }: { onSuccess: () => void }) {
  const [open, setOpen] = useState(false);
  const [pat, setPat] = useState("");
  const [label, setLabel] = useState("");
  const { toast } = useToast();

  const mutation = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/github/accounts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pat, label }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Failed to add account");
      }
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "GitHub account connected successfully" });
      setOpen(false);
      setPat("");
      setLabel("");
      onSuccess();
    },
    onError: (err: Error) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger nativeButton render={<Button size="sm" />}>
        <Plus className="h-4 w-4 mr-1.5" />
        Add Account
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <GitBranch className="h-5 w-5" />
            Connect GitHub Account
          </DialogTitle>
          <DialogDescription>
            Create a Personal Access Token in GitHub with{" "}
            <code className="text-xs bg-muted px-1 py-0.5 rounded">repo</code>,{" "}
            <code className="text-xs bg-muted px-1 py-0.5 rounded">read:user</code>{" "}
            and{" "}
            <code className="text-xs bg-muted px-1 py-0.5 rounded">project</code>{" "}
            and{" "}
            <code className="text-xs bg-muted px-1 py-0.5 rounded">read:org</code>{" "}
            scopes (projects/boards analysis, org boards included), then paste
            it here.{" "}
            <a
              href="https://github.com/settings/tokens/new?scopes=repo,read:user,project,read:org&description=Nexus%20issues"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-primary hover:underline"
            >
              Generate token
              <ExternalLink className="h-3 w-3" />
            </a>
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="space-y-2">
            <Label htmlFor="label">Label</Label>
            <Input
              id="label"
              placeholder="e.g. Personal, Work, Client XYZ"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="pat">Personal Access Token</Label>
            <Input
              id="pat"
              type="password"
              placeholder="ghp_xxxxxxxxxxxxxxxxxxxx"
              value={pat}
              onChange={(e) => setPat(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              The token is stored locally and never sent to any external service.
            </p>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button
            onClick={() => mutation.mutate()}
            disabled={!pat || !label || mutation.isPending}
          >
            {mutation.isPending && <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />}
            Connect
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function AccountRow({ account }: { account: GitHubAccount }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const refreshMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/github/accounts/${account.id}`, { method: "PATCH" });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Validation failed");
      }
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Account re-validated successfully" });
      queryClient.invalidateQueries({ queryKey: ["github-accounts"] });
    },
    onError: (err: Error) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
      queryClient.invalidateQueries({ queryKey: ["github-accounts"] });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/github/accounts/${account.id}`, { method: "DELETE" });
      if (!res.ok) throw new Error("Failed to remove account");
    },
    onSuccess: () => {
      toast({ title: "Account removed" });
      queryClient.invalidateQueries({ queryKey: ["github-accounts"] });
    },
    onError: (err: Error) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const meta = account.metadata;
  const isConnected = account.status === "connected";

  return (
    <div className="flex items-center gap-4 py-3">
      <Avatar className="h-9 w-9">
        <AvatarImage src={meta?.avatar_url} alt={meta?.login} />
        <AvatarFallback>
          <GitBranch className="h-4 w-4" />
        </AvatarFallback>
      </Avatar>

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-medium text-sm">{account.label}</span>
          {meta?.login && (
            <a
              href={`https://github.com/${meta.login}`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1"
            >
              @{meta.login}
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
        {meta?.name && (
          <p className="text-xs text-muted-foreground truncate">{meta.name}</p>
        )}
      </div>

      <div className="flex items-center gap-1 shrink-0">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => refreshMutation.mutate()}
          disabled={refreshMutation.isPending}
          title="Re-validate token"
        >
          {refreshMutation.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
        </Button>

        <AlertDialog>
        <AlertDialogTrigger nativeButton render={<Button variant="ghost" size="sm" disabled={deleteMutation.isPending} />}>
            <Trash2 className="h-4 w-4 text-destructive" />
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Remove GitHub account?</AlertDialogTitle>
              <AlertDialogDescription>
                This will remove{" "}
                <strong>{account.label}</strong> and its stored token.
                Any synced issues will also be deleted.
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

/**
 * `bare`: inside Connect apps (spec 39) — no card or title of its own (the
 * page around it says what it is), just its actions and its rows.
 */
export function GitHubAccountsSection({ bare = false }: { bare?: boolean } = {}) {
  const queryClient = useQueryClient();

  const { data: accounts = [], isLoading } = useQuery<GitHubAccount[]>({
    queryKey: ["github-accounts"],
    queryFn: async () => {
      const res = await fetch("/api/github/accounts");
      if (!res.ok) throw new Error("Failed to load GitHub accounts");
      return res.json();
    },
  });

  const refresh = () => queryClient.invalidateQueries({ queryKey: ["github-accounts"] });

  return (
    <Card className={bare ? "gap-3 border-0 bg-transparent py-0 shadow-none ring-0" : undefined}>
      <CardHeader className={bare ? "px-0" : undefined}>
        <div className="flex items-center justify-between">
          <div className={bare ? "sr-only" : undefined}>
            <CardTitle className="flex items-center gap-2">
              <GitBranch className="h-5 w-5" />
              GitHub Accounts
            </CardTitle>
            <CardDescription className="mt-1">
              Connect multiple GitHub accounts using Personal Access Tokens to
              import issues into your projects.
            </CardDescription>
          </div>
          <AddAccountDialog onSuccess={refresh} />
        </div>
      </CardHeader>
      <CardContent className={bare ? "rounded-xl border border-border bg-card/60 px-3" : undefined}>
        {isLoading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground py-4">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading accounts...
          </div>
        ) : accounts.length === 0 ? (
          <div className="py-8 text-center">
            <GitBranch className="h-10 w-10 mx-auto text-muted-foreground/40 mb-3" />
            <p className="text-sm text-muted-foreground">No GitHub accounts connected yet.</p>
            <p className="text-xs text-muted-foreground mt-1">
              Add an account to start importing issues.
            </p>
          </div>
        ) : (
          <div className="divide-y">
            {accounts.map((account) => (
              <AccountRow key={account.id} account={account} />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
