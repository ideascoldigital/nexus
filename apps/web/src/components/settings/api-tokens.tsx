"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Copy, KeyRound, Loader2, Plus, Trash2 } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
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
import { useToast } from "@/hooks/use-toast";
import { API_SCOPES, type ApiScope } from "@/lib/api-scopes";

/**
 * Bearer tokens for the MCP control surface (spec 21) — how a local Claude, or
 * any other system, reaches this Nexus. The card exists mostly to make the
 * blast radius of each token visible: what it can do, when it was last used,
 * and a one-click revoke for the day one leaks.
 */

type ApiTokenSummary = {
  id: string;
  name: string;
  scopes: ApiScope[];
  lastUsedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
};

/**
 * What creation returns, and the only time the token exists outside the
 * client's own config. The ready-made command rides along so connecting is a
 * paste rather than three fields assembled by hand.
 */
type IssuedToken = ApiTokenSummary & {
  token: string;
  mcpUrl: string;
  command: string;
};

/** What each scope lets a holder do, in the terms of the thing it affects. */
const SCOPE_COPY: Record<ApiScope, { label: string; detail: string }> = {
  "projects:read": {
    label: "Read projects",
    detail: "List projects, features and phases.",
  },
  "projects:write": {
    label: "Create projects",
    detail: "Create projects, clone their repositories and recognise their stack.",
  },
  "files:read": {
    label: "Read project files",
    detail: "List and read the files in a project's folders — never .env files, keys or other secrets.",
  },
  "files:write": {
    label: "Edit project files",
    detail: "Create and edit files in a project's folders on this machine — never .env files, keys or .git.",
  },
  "tasks:read": {
    label: "Read runs",
    detail: "Activity, run status and logs — what is blocked or finished.",
  },
  "tasks:write": {
    label: "Send tasks",
    detail: "Queue work onto a sandbox that already exists.",
  },
  "sandboxes:read": {
    label: "Read sandboxes",
    detail: "List machines, their health and bootstrap logs.",
  },
  "sandboxes:write": {
    label: "Control sandboxes",
    detail: "Launch, pause and resume machines — this provisions real infrastructure and costs money.",
  },
};

/** The one scope worth a second look before handing the token to something. */
const COSTS_MONEY: ApiScope = "sandboxes:write";

function formatWhen(value: string | null): string {
  if (!value) return "never";
  return new Date(value).toLocaleString();
}

export function ApiTokensSection() {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [scopes, setScopes] = useState<ApiScope[]>(["tasks:read"]);
  const [issued, setIssued] = useState<IssuedToken | null>(null);
  const [copied, setCopied] = useState<"command" | "token" | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<ApiTokenSummary | null>(null);

  const { data: tokens = [], isLoading } = useQuery<ApiTokenSummary[]>({
    queryKey: ["api-tokens"],
    queryFn: async () => {
      const res = await fetch("/api/api-tokens");
      if (!res.ok) throw new Error("Could not load tokens");
      return res.json();
    },
  });

  const create = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/api-tokens", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, scopes }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.error ?? "Could not create the token");
      return body as IssuedToken;
    },
    onSuccess: (body) => {
      queryClient.invalidateQueries({ queryKey: ["api-tokens"] });
      setCreating(false);
      setName("");
      setScopes(["tasks:read"]);
      // The only moment this value exists outside the client's config.
      setIssued(body);
    },
    onError: (err: Error) => {
      toast({ title: "Could not create the token", description: err.message });
    },
  });

  const revoke = useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(`/api/api-tokens/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error("Could not revoke the token");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["api-tokens"] });
      toast({ title: "Token revoked" });
    },
    onError: (err: Error) => {
      toast({ title: "Could not revoke the token", description: err.message });
    },
  });

  const toggleScope = (scope: ApiScope) => {
    setScopes((prev) =>
      prev.includes(scope) ? prev.filter((s) => s !== scope) : [...prev, scope],
    );
  };

  const copy = async (what: "command" | "token") => {
    if (!issued) return;
    await navigator.clipboard.writeText(
      what === "command" ? issued.command : issued.token,
    );
    setCopied(what);
    setTimeout(() => setCopied(null), 2000);
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <KeyRound className="h-5 w-5" />
          API tokens
        </CardTitle>
        <CardDescription>
          Bearer tokens for the MCP control surface — how a local Claude, or
          another system, drives this Nexus. Each token carries only the scopes
          you tick, so one handed to an external system need not be able to do
          everything you can.
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-4">
        <div className="flex justify-end">
          <Button size="sm" onClick={() => setCreating(true)}>
            <Plus className="h-4 w-4 mr-1.5" />
            New token
          </Button>
        </div>

        {isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : tokens.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No tokens yet. Nothing outside this dashboard can reach Nexus until
            you create one.
          </p>
        ) : (
          <ul className="divide-y rounded-md border">
            {tokens.map((token) => (
              <li
                key={token.id}
                className="flex items-start justify-between gap-4 p-3"
              >
                <div className="min-w-0 space-y-1">
                  <div className="flex items-center gap-2">
                    <span className="font-medium truncate">{token.name}</span>
                    {token.revokedAt && (
                      <Badge variant="outline">revoked</Badge>
                    )}
                  </div>
                  <div className="flex flex-wrap gap-1">
                    {token.scopes.map((scope) => (
                      <Badge
                        key={scope}
                        variant={
                          scope === COSTS_MONEY ? "destructive" : "secondary"
                        }
                        className="text-xs font-normal"
                      >
                        {scope}
                      </Badge>
                    ))}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Last used {formatWhen(token.lastUsedAt)} · created{" "}
                    {formatWhen(token.createdAt)}
                  </p>
                </div>

                {!token.revokedAt && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setRevokeTarget(token)}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </CardContent>

      {/* Create */}
      <Dialog open={creating} onOpenChange={setCreating}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New API token</DialogTitle>
            <DialogDescription>
              The token is shown once, when it is created. It is stored hashed,
              so it cannot be shown again — losing it means issuing a new one.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="token-name">Name</Label>
              <Input
                id="token-name"
                value={name}
                placeholder="local claude"
                onChange={(e) => setName(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                What holds it — so a token you find later is one you can place.
              </p>
            </div>

            <div className="space-y-2">
              <Label>Scopes</Label>
              <div className="space-y-2">
                {API_SCOPES.map((scope) => (
                  <label
                    key={scope}
                    className="flex items-start gap-2 cursor-pointer"
                  >
                    <input
                      type="checkbox"
                      checked={scopes.includes(scope)}
                      onChange={() => toggleScope(scope)}
                      className="mt-1 h-3.5 w-3.5 accent-primary"
                    />
                    <span className="space-y-0.5">
                      <span className="flex items-center gap-2 text-sm font-medium">
                        {SCOPE_COPY[scope].label}
                        <code className="text-xs text-muted-foreground font-normal">
                          {scope}
                        </code>
                      </span>
                      <span
                        className={`block text-xs ${
                          scope === COSTS_MONEY
                            ? "text-destructive"
                            : "text-muted-foreground"
                        }`}
                      >
                        {SCOPE_COPY[scope].detail}
                      </span>
                    </span>
                  </label>
                ))}
              </div>
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setCreating(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => create.mutate()}
              disabled={!name.trim() || scopes.length === 0 || create.isPending}
            >
              {create.isPending && (
                <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />
              )}
              Create token
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Shown once */}
      <Dialog
        open={issued !== null}
        onOpenChange={(open) => {
          if (!open) setIssued(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Connect your client</DialogTitle>
            <DialogDescription>
              This is the only time the token is shown. Nexus stores only its
              hash, so if you lose it you issue a new one.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="space-y-2">
              <Label>Run this where your Claude lives</Label>
              <code className="block rounded-md border bg-muted p-3 text-xs font-mono break-all">
                {issued?.command}
              </code>
              <p className="text-xs text-muted-foreground">
                Pointing at <code>{issued?.mcpUrl}</code> — the address you are
                reading this dashboard on. If your client reaches Nexus by
                another route (a tailnet name, a proxy), swap the URL for that
                one; the token is the same.
              </p>
              <Button size="sm" onClick={() => copy("command")}>
                {copied === "command" ? (
                  <Check className="h-4 w-4 mr-1.5" />
                ) : (
                  <Copy className="h-4 w-4 mr-1.5" />
                )}
                Copy command
              </Button>
            </div>

            <div className="space-y-2 border-t pt-3">
              <Label className="text-xs text-muted-foreground">
                Or the bare token, for a client configured by hand
              </Label>
              <code className="block rounded-md border bg-muted p-3 text-xs font-mono break-all">
                {issued?.token}
              </code>
              <Button variant="outline" size="sm" onClick={() => copy("token")}>
                {copied === "token" ? (
                  <Check className="h-4 w-4 mr-1.5" />
                ) : (
                  <Copy className="h-4 w-4 mr-1.5" />
                )}
                Copy token
              </Button>
            </div>
          </div>

          <DialogFooter>
            <Button onClick={() => setIssued(null)}>Done</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Revoke */}
      <AlertDialog
        open={revokeTarget !== null}
        onOpenChange={(open) => {
          if (!open) setRevokeTarget(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Revoke “{revokeTarget?.name}”?
            </AlertDialogTitle>
            <AlertDialogDescription>
              Anything using this token stops working immediately. The record of
              it — when it was created and last used — is kept, which is what
              you want if you are revoking because it leaked.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (revokeTarget) revoke.mutate(revokeTarget.id);
                setRevokeTarget(null);
              }}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Revoke token
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
