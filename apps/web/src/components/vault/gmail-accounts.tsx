"use client";

// Gmail for bots (spec 34): set up the user's own Google OAuth app once, then
// connect accounts through Google's consent screen in their browser. Bots use
// them through Nexus — the tokens stay sealed here.

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, ExternalLink, Loader2, Mail, Plus, Trash2 } from "lucide-react";

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
import type { GoogleAccount } from "@/services/google";
import { openExternal } from "@/services/updates";

const field =
  "w-full rounded-lg border border-input bg-transparent px-3 py-2 text-[13px] outline-none placeholder:text-muted-foreground focus:border-ring";

/** How long the list keeps checking for the account after "Connect". */
const WAIT_MS = 3 * 60_000;

export function GmailAccounts() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { data: app } = useQuery({ queryKey: ["google-app"], queryFn: getGoogleApp });
  // After "Connect": the account count it started from, until one more shows
  // up (or a few minutes pass) — meanwhile the list keeps checking.
  const [countAtStart, setCountAtStart] = useState<number | null>(null);
  const { data: accounts } = useQuery({
    queryKey: ["google-accounts"],
    queryFn: listGoogleAccounts,
    refetchInterval: (q) => (countAtStart !== null && (q.state.data?.length ?? 0) <= countAtStart ? 3000 : false),
  });
  const waitingSince = countAtStart !== null && (accounts?.length ?? 0) <= countAtStart;
  const [setupOpen, setSetupOpen] = useState(false);
  const [open, setOpen] = useState<string | null>(null);

  const connect = useMutation({
    mutationFn: async () => {
      const { url } = await startGoogleConnect();
      await openExternal(url);
    },
    onSuccess: () => {
      setCountAtStart(accounts?.length ?? 0);
      setTimeout(() => setCountAtStart(null), WAIT_MS);
      toast({ title: "Finish in your browser", description: "Sign in with Google there and allow Gmail. This list updates by itself." });
    },
    onError: (err) => toast({ title: "Could not start", description: err instanceof Error ? err.message : undefined, variant: "destructive" }),
  });

  const configured = app?.configured ?? false;

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 px-1">
        <Mail className="h-4 w-4 text-muted-foreground" />
        <span className="text-[13px] font-medium">Gmail</span>
        <span className="text-[12px] text-muted-foreground">— bots read, draft and send without signing in</span>
        {configured && (
          <Button
            size="sm"
            variant="secondary"
            className="ml-auto h-8 rounded-full"
            disabled={connect.isPending}
            onClick={() => connect.mutate()}
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
            <AccountRow key={a.id} account={a} open={open === a.id} onToggle={() => setOpen(open === a.id ? null : a.id)} />
          ))}
          {accounts && accounts.length === 0 && (
            <p className="rounded-2xl border border-dashed border-border px-4 py-3 text-[12.5px] text-muted-foreground">
              No account yet. Connect one and your bots use Gmail through Nexus instead of their browser.
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

function AccountRow({ account, open, onToggle }: { account: GoogleAccount; open: boolean; onToggle: () => void }) {
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
  return (
    <div className="rounded-2xl border border-border bg-card/60">
      <button type="button" onClick={onToggle} className="flex w-full items-center gap-3 px-4 py-3 text-left">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent text-[13px] font-semibold uppercase">
          {account.email.charAt(0)}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13.5px] font-medium">{account.email}</span>
          <span className={cn("block text-[12px]", ok ? "text-muted-foreground" : "text-destructive")}>
            {ok ? "Connected" : "Google revoked access — connect it again"}
          </span>
        </span>
        <span className="shrink-0 rounded-full bg-accent px-2 py-0.5 text-[11px] text-muted-foreground">
          {account.botIds ? `${account.botIds.length} ${account.botIds.length === 1 ? "bot" : "bots"}` : "All bots"}
        </span>
        {open ? <ChevronDown className="h-4 w-4 text-muted-foreground" /> : <ChevronRight className="h-4 w-4 text-muted-foreground" />}
      </button>
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
        description="Nexus revokes its access at Google and forgets the tokens. Bots stop using this Gmail."
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
        Gmail needs a Google OAuth app of your own — one time, about five minutes. With a Google Workspace account,
        make it <span className="text-foreground">Internal</span>: no review by Google, and access does not expire.
      </p>
      <ol className="list-decimal space-y-1 pl-5 text-[12.5px] text-muted-foreground">
        <li>In {link("https://console.cloud.google.com/projectcreate", "Google Cloud")}, create a project (or pick one).</li>
        <li>Enable the {link("https://console.cloud.google.com/apis/library/gmail.googleapis.com", "Gmail API")}.</li>
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
