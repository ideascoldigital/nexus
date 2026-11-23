"use client";

// Google for bots — Gmail (spec 34) and Calendar (spec 36): set up the user's
// own Google OAuth app once, then connect accounts through Google's consent
// screen in their browser. One account can have either app or both; adding one
// later is an incremental consent that keeps the other. Bots use them through
// Nexus — the tokens stay sealed here.

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarDays, ChevronDown, ChevronRight, ExternalLink, Loader2, Mail, Plus, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { BotAccess } from "@/components/vault/vault-item-dialog";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import {
  disconnectGoogleAccount,
  getGoogleApp,
  listGoogleAccounts,
  saveGoogleApp,
  setGoogleAccountBots,
  startGoogleConnect,
} from "@/services/gmail";
import type { GoogleApp as GoogleAppName } from "@/lib/gmail";
import type { GoogleAccount } from "@/services/google";
import { openExternal } from "@/services/updates";

const field =
  "w-full rounded-lg border border-input bg-transparent px-3 py-2 text-[13px] outline-none placeholder:text-muted-foreground focus:border-ring";

/** How long the list keeps checking for the account after "Connect". */
const WAIT_MS = 3 * 60_000;

const APPS: Record<GoogleAppName, { name: string; short: string; tagline: string; icon: typeof Mail; empty: string }> = {
  gmail: {
    name: "Gmail",
    short: "Gmail",
    tagline: "bots read, draft and send without signing in",
    icon: Mail,
    empty: "No account yet. Connect one and your bots use Gmail through Nexus instead of their browser.",
  },
  calendar: {
    name: "Google Calendar",
    short: "Calendar",
    tagline: "bots read the agenda, find free time and schedule",
    icon: CalendarDays,
    empty: "No account yet. Connect one and your bots read and schedule on your calendar through Nexus.",
  },
};

const hasApp = (a: GoogleAccount, app: GoogleAppName) => a.status === "connected" && a.apps.includes(app);

export function GoogleAccounts({ app: which }: { app: GoogleAppName }) {
  const meta = APPS[which];
  const Icon = meta.icon;
  const qc = useQueryClient();
  const { toast } = useToast();
  const { data: app } = useQuery({ queryKey: ["google-app"], queryFn: getGoogleApp });
  // After "Connect": how many accounts had this app when it started, until one
  // more does (a new account, or Calendar added to a Gmail one) or a few
  // minutes pass — meanwhile the list keeps checking.
  const [countAtStart, setCountAtStart] = useState<number | null>(null);
  const withApp = (list: GoogleAccount[] | undefined) => list?.filter((a) => hasApp(a, which)).length ?? 0;
  const { data: accounts } = useQuery({
    queryKey: ["google-accounts"],
    queryFn: listGoogleAccounts,
    refetchInterval: (q) => (countAtStart !== null && withApp(q.state.data) <= countAtStart ? 3000 : false),
  });
  const waitingSince = countAtStart !== null && withApp(accounts) <= countAtStart;
  const [setupOpen, setSetupOpen] = useState(false);
  const [open, setOpen] = useState<string | null>(null);

  // loginHint: adding this app to an account already connected for the other.
  const connect = useMutation({
    mutationFn: async (loginHint?: string) => {
      const { url } = await startGoogleConnect({ apps: [which], loginHint });
      await openExternal(url);
    },
    onSuccess: () => {
      setCountAtStart(withApp(accounts));
      setTimeout(() => setCountAtStart(null), WAIT_MS);
      toast({ title: "Finish in your browser", description: `Sign in with Google there and allow ${meta.name}. This list updates by itself.` });
    },
    onError: (err) => toast({ title: "Could not start", description: err instanceof Error ? err.message : undefined, variant: "destructive" }),
  });

  const configured = app?.configured ?? false;

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 px-1">
        <Icon className="h-4 w-4 text-muted-foreground" />
        <span className="text-[13px] font-medium">{meta.name}</span>
        <span className="text-[12px] text-muted-foreground">— {meta.tagline}</span>
        {configured && (
          <Button
            size="sm"
            variant="secondary"
            className="ml-auto h-8 rounded-full"
            disabled={connect.isPending}
            onClick={() => connect.mutate(undefined)}
          >
            {connect.isPending || waitingSince ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
            {waitingSince ? "Waiting for Google…" : "Connect account"}
          </Button>
        )}
      </div>

      {!configured || setupOpen ? (
        <AppSetup
          clientId={app?.clientId ?? null}
          onDone={() => {
            setSetupOpen(false);
            void qc.invalidateQueries({ queryKey: ["google-app"] });
          }}
          onCancel={configured ? () => setSetupOpen(false) : undefined}
        />
      ) : (
        <>
          {accounts?.map((a) => (
            <AccountRow
              key={a.id}
              account={a}
              app={which}
              open={open === a.id}
              onToggle={() => setOpen(open === a.id ? null : a.id)}
              onAddApp={() => connect.mutate(a.email)}
              adding={connect.isPending || waitingSince}
            />
          ))}
          {accounts && accounts.length === 0 && (
            <p className="rounded-2xl border border-dashed border-border px-4 py-3 text-[12.5px] text-muted-foreground">
              {meta.empty}
            </p>
          )}
          {which === "calendar" && (
            <p className="px-1 text-[11.5px] text-muted-foreground">
              Set the app up before Calendar existed? Enable the{" "}
              <button
                type="button"
                onClick={() => void openExternal("https://console.cloud.google.com/apis/library/calendar-json.googleapis.com")}
                className="underline underline-offset-2 hover:text-foreground"
              >
                Google Calendar API
              </button>{" "}
              in its project too.
            </p>
          )}
          <button
            type="button"
            onClick={() => setSetupOpen(true)}
            className="px-1 text-[11.5px] text-muted-foreground hover:text-foreground"
          >
            Google OAuth app: {app?.clientId?.split("-")[0]}… · change
          </button>
        </>
      )}
    </div>
  );
}

function AccountRow({
  account,
  app,
  open,
  onToggle,
  onAddApp,
  adding,
}: {
  account: GoogleAccount;
  app: GoogleAppName;
  open: boolean;
  onToggle: () => void;
  onAddApp: () => void;
  adding: boolean;
}) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [confirm, setConfirm] = useState(false);
  const refresh = () => void qc.invalidateQueries({ queryKey: ["google-accounts"] });
  const bots = useMutation({
    mutationFn: (botIds: string[] | null) => setGoogleAccountBots(account.id, botIds),
    onSuccess: refresh,
    onError: (err) => toast({ title: "Not saved", description: err instanceof Error ? err.message : undefined, variant: "destructive" }),
  });
  const remove = useMutation({
    mutationFn: () => disconnectGoogleAccount(account.id),
    onSuccess: refresh,
    onError: (err) => toast({ title: "Could not disconnect", description: err instanceof Error ? err.message : undefined, variant: "destructive" }),
  });
  const ok = account.status === "connected";
  const missingApp = ok && !account.apps.includes(app);
  const appList = account.apps.map((a) => APPS[a].short).join(" · ");
  return (
    <div className="rounded-2xl border border-border bg-card/60">
      <button type="button" onClick={onToggle} className="flex w-full items-center gap-3 px-4 py-3 text-left">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent text-[13px] font-semibold uppercase">
          {account.email.charAt(0)}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13.5px] font-medium">{account.email}</span>
          <span className={cn("block text-[12px]", ok ? "text-muted-foreground" : "text-destructive")}>
            {!ok
              ? "Google revoked access — connect it again"
              : missingApp
                ? `${appList || "Connected"} only — ${APPS[app].short} not added yet`
                : `Connected · ${appList}`}
          </span>
        </span>
        <span className="shrink-0 rounded-full bg-accent px-2 py-0.5 text-[11px] text-muted-foreground">
          {account.botIds ? `${account.botIds.length} ${account.botIds.length === 1 ? "bot" : "bots"}` : "All bots"}
        </span>
        {open ? <ChevronDown className="h-4 w-4 text-muted-foreground" /> : <ChevronRight className="h-4 w-4 text-muted-foreground" />}
      </button>
      {missingApp && (
        <div className="flex items-center gap-2 border-t border-border/70 px-4 py-2.5">
          <span className="flex-1 text-[12px] text-muted-foreground">
            Add {APPS[app].name} to this account — Google asks once, and {appList} keeps working.
          </span>
          <Button size="sm" variant="secondary" className="h-8 rounded-full" disabled={adding} onClick={onAddApp}>
            {adding ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
            Add {APPS[app].short}
          </Button>
        </div>
      )}
      {open && (
        <div className="space-y-3 border-t border-border/70 px-4 py-3">
          <BotAccess value={account.botIds} onChange={(v) => bots.mutate(v)} />
          <div className="flex justify-end">
            <Button size="sm" variant="ghost" className="text-destructive" onClick={() => setConfirm(true)}>
              <Trash2 className="h-3.5 w-3.5" />
              Disconnect
            </Button>
          </div>
        </div>
      )}
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title={`Disconnect ${account.email}?`}
        description={`Nexus revokes its access at Google and forgets the tokens. Bots stop using ${
          account.apps.length ? account.apps.map((a) => APPS[a].name).join(" and ") : "this account"
        } for it.`}
        confirmLabel="Disconnect"
        onConfirm={() => remove.mutate()}
      />
    </div>
  );
}

function AppSetup({ clientId, onDone, onCancel }: { clientId: string | null; onDone: () => void; onCancel?: () => void }) {
  const { toast } = useToast();
  const [id, setId] = useState(clientId ?? "");
  const [secret, setSecret] = useState("");
  const save = useMutation({
    mutationFn: () => saveGoogleApp(id, secret),
    onSuccess: onDone,
    onError: (err) => toast({ title: "Not saved", description: err instanceof Error ? err.message : undefined, variant: "destructive" }),
  });
  const link = (href: string, label: string) => (
    <button type="button" onClick={() => void openExternal(href)} className="inline-flex items-center gap-0.5 underline underline-offset-2 hover:text-foreground">
      {label}
      <ExternalLink className="h-3 w-3" />
    </button>
  );
  return (
    <div className="space-y-3 rounded-2xl border border-border bg-card/60 px-4 py-3.5">
      <p className="text-[12.5px] text-muted-foreground">
        Gmail and Google Calendar need a Google OAuth app of your own — one time, about five minutes, and the same
        app serves both. With a Google Workspace account, make it <span className="text-foreground">Internal</span>:
        no review by Google, and access does not expire.
      </p>
      <ol className="list-decimal space-y-1 pl-5 text-[12.5px] text-muted-foreground">
        <li>In {link("https://console.cloud.google.com/projectcreate", "Google Cloud")}, create a project (or pick one).</li>
        <li>
          Enable the {link("https://console.cloud.google.com/apis/library/gmail.googleapis.com", "Gmail API")} and the{" "}
          {link("https://console.cloud.google.com/apis/library/calendar-json.googleapis.com", "Google Calendar API")} —
          the ones your bots will use.
        </li>
        <li>
          In {link("https://console.cloud.google.com/auth/branding", "Google Auth Platform")}, set up the app with
          audience <span className="text-foreground">Internal</span>.
        </li>
        <li>
          Under {link("https://console.cloud.google.com/auth/clients", "Clients")}, create a client of type{" "}
          <span className="text-foreground">Desktop app</span>.
        </li>
        <li>Paste its client ID and secret here.</li>
      </ol>
      <input className={field} value={id} onChange={(e) => setId(e.target.value)} placeholder="Client ID (…apps.googleusercontent.com)" spellCheck={false} autoComplete="off" />
      <input className={field} type="password" value={secret} onChange={(e) => setSecret(e.target.value)} placeholder="Client secret" spellCheck={false} autoComplete="off" />
      <div className="flex justify-end gap-2">
        {onCancel && (
          <Button size="sm" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        )}
        <Button size="sm" disabled={!id.trim() || !secret.trim() || save.isPending} onClick={() => save.mutate()}>
          {save.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          Save
        </Button>
      </div>
    </div>
  );
}
