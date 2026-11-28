"use client";

import { useEffect, useState } from "react";
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
  AlertCircle,
  CheckCircle,
  CheckSquare,
  ExternalLink,
  Link2,
  Loader2,
  Settings2,
  Trash2,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";

interface ClickUpAccount {
  id: string;
  label: string;
  status: string;
  lastCheckedAt: string | null;
  metadata: {
    userId: number;
    username: string;
    email: string | null;
    profilePicture: string | null;
    initials: string | null;
    teams: { id: string; name: string }[];
  } | null;
}

interface ClickUpConfig {
  configured: boolean;
  clientId: string | null;
  /** What /oauth/start will actually send as redirect_uri. */
  callbackUrl?: string;
}

/**
 * Prefer the server's own answer: it is the value ClickUp will be asked to
 * match. `window.location.origin` only agrees when the server can see the same
 * origin, which it cannot behind a container bound to 0.0.0.0.
 */
function callbackUrl(config: ClickUpConfig | undefined) {
  if (config?.callbackUrl) return config.callbackUrl;
  return typeof window === "undefined"
    ? ""
    : `${window.location.origin}/api/clickup/oauth/callback`;
}

function ConfigureAppDialog({
  config,
  onSuccess,
}: {
  config: ClickUpConfig | undefined;
  onSuccess: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const { toast } = useToast();
  const configured = config?.configured ?? false;

  const handleOpenChange = (next: boolean) => {
    if (next) setClientId(config?.clientId ?? "");
    setOpen(next);
  };

  const mutation = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/clickup/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientId, clientSecret }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(
          typeof err.error === "string" ? err.error : "Failed to save app credentials"
        );
      }
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "ClickUp app configured" });
      setOpen(false);
      setClientSecret("");
      onSuccess();
    },
    onError: (err: Error) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger
        nativeButton
        render={<Button size="sm" variant={configured ? "ghost" : "default"} />}
      >
        <Settings2 className="h-4 w-4 mr-1.5" />
        {configured ? "App settings" : "Set up ClickUp app"}
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <CheckSquare className="h-5 w-5" />
            Configure ClickUp OAuth App
          </DialogTitle>
          <DialogDescription>
            One-time setup: create an OAuth app in ClickUp (Settings →
            Integrations → ClickUp API), set its redirect URL to the one below,
            then paste the Client ID and Secret here.{" "}
            <a
              href="https://app.clickup.com/settings/team/clickup-api"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-primary hover:underline"
            >
              Open ClickUp API settings
              <ExternalLink className="h-3 w-3" />
            </a>
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="space-y-2">
            <Label>Redirect URL (paste into your ClickUp app)</Label>
            <code className="block text-xs bg-muted px-2 py-1.5 rounded break-all select-all">
              {callbackUrl(config)}
            </code>
          </div>
          <div className="space-y-2">
            <Label htmlFor="clickup-client-id">Client ID</Label>
            <Input
              id="clickup-client-id"
              placeholder="ABC123..."
              value={clientId}
              onChange={(e) => setClientId(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="clickup-client-secret">Client Secret</Label>
            <Input
              id="clickup-client-secret"
              type="password"
              autoComplete="new-password"
              placeholder={configured ? "•••••••• (unchanged secrets must be re-entered)" : "Secret from your ClickUp app"}
              value={clientSecret}
              onChange={(e) => setClientSecret(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              Stored locally and never sent anywhere except ClickUp&apos;s token
              endpoint.
            </p>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button
            onClick={() => mutation.mutate()}
            disabled={!clientId || !clientSecret || mutation.isPending}
          >
            {mutation.isPending && <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />}
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function AccountRow({ account }: { account: ClickUpAccount }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const refreshMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/clickup/accounts/${account.id}`, {
        method: "PATCH",
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Validation failed");
      }
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Account re-validated successfully" });
      queryClient.invalidateQueries({ queryKey: ["clickup-accounts"] });
    },
    onError: (err: Error) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
      queryClient.invalidateQueries({ queryKey: ["clickup-accounts"] });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/clickup/accounts/${account.id}`, {
        method: "DELETE",
      });
      if (!res.ok) throw new Error("Failed to remove account");
    },
    onSuccess: () => {
      toast({ title: "Account removed" });
      queryClient.invalidateQueries({ queryKey: ["clickup-accounts"] });
    },
    onError: (err: Error) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const meta = account.metadata;
  const isConnected = account.status === "connected";
  const teams = meta?.teams ?? [];

  return (
    <div className="flex items-center gap-4 py-3">
      <Avatar className="h-9 w-9">
        <AvatarImage src={meta?.profilePicture ?? undefined} alt={meta?.username} />
        <AvatarFallback>
          {meta?.initials || <CheckSquare className="h-4 w-4" />}
        </AvatarFallback>
      </Avatar>

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-medium text-sm">{account.label}</span>
          {meta?.email && (
            <span className="text-xs text-muted-foreground">{meta.email}</span>
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
        {teams.length > 0 && (
          <p className="text-xs text-muted-foreground truncate">
            {teams.map((t) => t.name).join(" · ")}
          </p>
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
          <AlertDialogTrigger
            nativeButton
            render={<Button variant="ghost" size="sm" disabled={deleteMutation.isPending} />}
          >
            <Trash2 className="h-4 w-4 text-destructive" />
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Remove ClickUp account?</AlertDialogTitle>
              <AlertDialogDescription>
                This will remove <strong>{account.label}</strong> and its stored
                access token. You can reconnect at any time.
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
export function ClickUpAccountsSection({ bare = false }: { bare?: boolean } = {}) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  // Sticky, not just a toast: the round-trip through ClickUp takes long
  // enough that a 5-second toast is easy to come back to a blank card on.
  const [oauthError, setOauthError] = useState<string | null>(() =>
    typeof window === "undefined"
      ? null
      : new URLSearchParams(window.location.search).get("clickup_error")
  );

  const { data: config } = useQuery<ClickUpConfig>({
    queryKey: ["clickup-config"],
    queryFn: async () => {
      const res = await fetch("/api/clickup/config");
      if (!res.ok) throw new Error("Failed to load ClickUp config");
      return res.json();
    },
  });

  const { data: accounts = [], isLoading } = useQuery<ClickUpAccount[]>({
    queryKey: ["clickup-accounts"],
    queryFn: async () => {
      const res = await fetch("/api/clickup/accounts");
      if (!res.ok) throw new Error("Failed to load ClickUp accounts");
      return res.json();
    },
  });

  // Surface the OAuth round-trip's outcome (the callback redirects back here
  // with ?clickup=connected or ?clickup_error=...), then clean the URL.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const connected = params.get("clickup");
    const error = params.get("clickup_error");
    if (!connected && !error) return;
    if (connected === "connected") {
      toast({ title: "ClickUp account connected successfully" });
      queryClient.invalidateQueries({ queryKey: ["clickup-accounts"] });
    }
    params.delete("clickup");
    params.delete("clickup_error");
    const query = params.toString();
    window.history.replaceState(
      null,
      "",
      `${window.location.pathname}${query ? `?${query}` : ""}`
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const configured = config?.configured ?? false;

  return (
    <Card className={bare ? "gap-3 border-0 bg-transparent py-0 shadow-none ring-0" : undefined}>
      <CardHeader className={bare ? "px-0" : undefined}>
        <div className="flex items-center justify-between">
          <div className={bare ? "sr-only" : undefined}>
            <CardTitle className="flex items-center gap-2">
              <CheckSquare className="h-5 w-5" />
              ClickUp Accounts
            </CardTitle>
            <CardDescription className="mt-1">
              Connect one or more ClickUp accounts via OAuth to work with your
              tasks, lists and workspaces.
            </CardDescription>
          </div>
          <div className="flex items-center gap-2">
            <ConfigureAppDialog
              config={config}
              onSuccess={() =>
                queryClient.invalidateQueries({ queryKey: ["clickup-config"] })
              }
            />
            {configured && (
              <Button
                size="sm"
                onClick={() => {
                  window.location.href = "/api/clickup/oauth/start";
                }}
              >
                <Link2 className="h-4 w-4 mr-1.5" />
                Connect ClickUp
              </Button>
            )}
          </div>
        </div>
      </CardHeader>
      <CardContent className={bare ? "rounded-xl border border-border bg-card/60 px-3" : undefined}>
        {oauthError && (
          <div className="mb-4 flex items-start gap-2 rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2.5 text-sm">
            <AlertCircle className="h-4 w-4 mt-0.5 shrink-0 text-destructive" />
            <div className="flex-1 min-w-0">
              <p className="font-medium text-destructive">
                The ClickUp connection failed
              </p>
              <p className="text-xs text-muted-foreground mt-0.5 break-words">
                {oauthError}
              </p>
              <p className="text-xs text-muted-foreground mt-0.5">
                Check the app&apos;s Client Secret and redirect URL, then try
                again.
              </p>
            </div>
            <Button
              variant="ghost"
              size="sm"
              className="shrink-0 -mr-1"
              onClick={() => setOauthError(null)}
            >
              Dismiss
            </Button>
          </div>
        )}
        {isLoading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground py-4">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading accounts...
          </div>
        ) : accounts.length === 0 ? (
          <div className="py-8 text-center">
            <CheckSquare className="h-10 w-10 mx-auto text-muted-foreground/40 mb-3" />
            <p className="text-sm text-muted-foreground">
              No ClickUp accounts connected yet.
            </p>
            <p className="text-xs text-muted-foreground mt-1">
              {configured
                ? "Click “Connect ClickUp” to authorize your account."
                : "Set up the ClickUp app once, then connect accounts with a single click."}
            </p>
          </div>
        ) : (
          <>
            <div className="divide-y">
              {accounts.map((account) => (
                <AccountRow key={account.id} account={account} />
              ))}
            </div>
            <p className="text-xs text-muted-foreground mt-3">
              “Connect ClickUp” reuses your active ClickUp session — with the
              same login it refreshes that account. To add a different one,
              sign out of ClickUp (or use a private window) first.
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}
