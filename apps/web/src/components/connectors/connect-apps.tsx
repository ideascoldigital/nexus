"use client";

// Connect Apps (spec 35): the catalog of apps bots can use as tools. A list
// to browse — search, categories, what is connected — and, for one app, how
// to connect it: the steps to get a token, the fields, which bots may use it.
// Gmail and Google Calendar have their own setup (specs 34, 36) and show it here.

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, ExternalLink, Loader2, Search, Trash2 } from "lucide-react";
import {
  siAirtable,
  siBrave,
  siGithub,
  siGmail,
  siGooglecalendar,
  siHubspot,
  siMongodb,
  siNotion,
  siPostgresql,
  siStripe,
  siSupabase,
} from "simple-icons";

import { Button } from "@/components/ui/button";
import { BRAND_PATHS } from "@/components/ui/brand-icon";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { GoogleAccounts } from "@/components/vault/google-accounts";
import { BotAccess } from "@/components/vault/vault-item-dialog";
import { useToast } from "@/hooks/use-toast";
import { CONNECTOR_CATEGORIES, CONNECTORS, type ConnectorCategory, type ConnectorDef } from "@/lib/connectors";
import { cn } from "@/lib/utils";
import { disconnectConnector, listConnectors, saveConnector, setConnectorBots, type ConnectorStatus } from "@/services/connectors";
import { openExternal } from "@/services/updates";

const ICONS: Record<string, { path: string; hex: string }> = {
  gmail: siGmail,
  "google-calendar": siGooglecalendar,
  slack: { path: BRAND_PATHS.slack, hex: "4A154B" },
  notion: siNotion,
  airtable: siAirtable,
  github: siGithub,
  mongodb: siMongodb,
  postgres: siPostgresql,
  supabase: siSupabase,
  hubspot: siHubspot,
  stripe: siStripe,
  "brave-search": siBrave,
};

export function AppIcon({ id, size = 40 }: { id: string; size?: number }) {
  const icon = ICONS[id];
  return (
    <span
      className="flex shrink-0 items-center justify-center rounded-[10px] bg-white shadow-sm ring-1 ring-black/5"
      style={{ width: size, height: size }}
    >
      {icon ? (
        <svg viewBox="0 0 24 24" style={{ width: size * 0.55, height: size * 0.55 }} fill={`#${icon.hex}`} aria-hidden>
          <path d={icon.path} />
        </svg>
      ) : (
        <span className="text-[13px] font-semibold text-neutral-700">{id.charAt(0).toUpperCase()}</span>
      )}
    </span>
  );
}

const field =
  "w-full rounded-lg border border-input bg-transparent px-3 py-2 text-[13px] outline-none placeholder:text-muted-foreground focus:border-ring";

/** The catalog, then one app. `className` sizes the scrolling area. */
export function ConnectApps({ className }: { className?: string }) {
  const { data: statuses } = useQuery({ queryKey: ["connectors"], queryFn: listConnectors });
  const [openId, setOpenId] = useState<string | null>(null);
  const status = (id: string) => statuses?.find((s) => s.id === id);
  const open = openId ? CONNECTORS.find((c) => c.id === openId) : undefined;

  if (open) {
    return (
      <div className={className}>
        <AppDetail def={open} status={status(open.id)} onBack={() => setOpenId(null)} />
      </div>
    );
  }
  return (
    <div className={className}>
      <Catalog statuses={statuses} onOpen={setOpenId} />
    </div>
  );
}

function Catalog({ statuses, onOpen }: { statuses: ConnectorStatus[] | undefined; onOpen: (id: string) => void }) {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<ConnectorCategory | "All" | "Connected">("All");
  const connected = CONNECTORS.filter((c) => statuses?.find((s) => s.id === c.id)?.connected);
  const q = query.trim().toLowerCase();
  const matches = (c: ConnectorDef) => !q || `${c.name} ${c.tagline} ${c.category}`.toLowerCase().includes(q);

  const sections: { title: string; items: ConnectorDef[] }[] =
    category === "Connected"
      ? [{ title: "Connected", items: connected.filter(matches) }]
      : category !== "All"
        ? [{ title: category, items: CONNECTORS.filter((c) => c.category === category && matches(c)) }]
        : q
          ? [{ title: "Results", items: CONNECTORS.filter(matches) }]
          : [
              ...(connected.length ? [{ title: "Connected", items: connected }] : []),
              ...CONNECTOR_CATEGORIES.map((cat) => ({ title: cat, items: CONNECTORS.filter((c) => c.category === cat) })),
            ];

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-3">
        <div className="flex flex-1 items-center gap-2 rounded-full border border-border bg-card/60 px-3.5 py-2">
          <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search apps"
            className="min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-muted-foreground"
          />
        </div>
        {connected.length > 0 && (
          <button
            type="button"
            onClick={() => setCategory(category === "Connected" ? "All" : "Connected")}
            className="flex shrink-0 items-center gap-2 rounded-full px-2 py-1 text-[12.5px] text-muted-foreground hover:text-foreground"
          >
            <span className="flex -space-x-1.5">
              {connected.slice(0, 4).map((c) => (
                <AppIcon key={c.id} id={c.id} size={20} />
              ))}
            </span>
            {connected.length} connected
            <ChevronRight className="h-3.5 w-3.5" />
          </button>
        )}
      </div>

      <div className="flex flex-wrap gap-1.5">
        {(["All", ...CONNECTOR_CATEGORIES] as const).map((c) => (
          <button
            key={c}
            type="button"
            onClick={() => setCategory(c)}
            className={cn(
              "rounded-full px-3 py-1 text-[12.5px] transition-colors",
              category === c ? "bg-foreground text-background" : "bg-accent text-muted-foreground hover:text-foreground",
            )}
          >
            {c}
          </button>
        ))}
      </div>

      {sections
        .filter((s) => s.items.length)
        .map((s) => (
          <section key={s.title} className="space-y-1">
            <h3 className="px-1 text-[13.5px] font-medium">{s.title}</h3>
            <div className="grid gap-x-6 sm:grid-cols-2">
              {s.items.map((c) => (
                <AppRow key={c.id} def={c} status={statuses?.find((x) => x.id === c.id)} onOpen={() => onOpen(c.id)} />
              ))}
            </div>
          </section>
        ))}
      {sections.every((s) => !s.items.length) && (
        <p className="py-8 text-center text-[12.5px] text-muted-foreground">No app matches “{query}”.</p>
      )}
    </div>
  );
}

function AppRow({ def, status, onOpen }: { def: ConnectorDef; status: ConnectorStatus | undefined; onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="group flex w-full items-center gap-3 rounded-xl px-1 py-2.5 text-left transition-colors hover:bg-accent/50"
    >
      <AppIcon id={def.id} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13.5px] font-medium">{def.name}</span>
        <span className="block truncate text-[12px] text-muted-foreground">{def.tagline}</span>
      </span>
      {status?.connected ? (
        <span className="shrink-0 px-3 text-[12.5px] font-medium text-emerald-500">Connected</span>
      ) : (
        <span className="shrink-0 rounded-full bg-accent px-4 py-1.5 text-[12.5px] font-medium group-hover:bg-accent/80">
          Connect
        </span>
      )}
    </button>
  );
}

function AppDetail({ def, status, onBack }: { def: ConnectorDef; status: ConnectorStatus | undefined; onBack: () => void }) {
  return (
    <div className="space-y-5">
      <button type="button" onClick={onBack} className="flex items-center gap-1 text-[12.5px] text-muted-foreground hover:text-foreground">
        <ChevronLeft className="h-3.5 w-3.5" />
        Connect Apps
      </button>
      <div className="flex items-center gap-3">
        <AppIcon id={def.id} size={48} />
        <div className="min-w-0 flex-1">
          <h3 className="text-[16px] font-semibold">{def.name}</h3>
          <p className="text-[12.5px] text-muted-foreground">{def.tagline}</p>
        </div>
        {status?.connected && <span className="text-[12.5px] font-medium text-emerald-500">Connected</span>}
      </div>
      {def.kind === "native" ? (
        <GoogleAccounts app={def.id === "google-calendar" ? "calendar" : "gmail"} />
      ) : (
        <McpSetup key={status?.updatedAt ?? "new"} def={def} status={status} onDisconnected={onBack} />
      )}
    </div>
  );
}

function McpSetup({ def, status, onDisconnected }: { def: ConnectorDef; status: ConnectorStatus | undefined; onDisconnected: () => void }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const connected = status?.connected ?? false;
  const [values, setValues] = useState<Record<string, string | boolean>>(() =>
    Object.fromEntries(
      def.fields.map((f) => [
        f.key,
        f.type === "toggle" ? (status?.values[f.key] ?? String(f.defaultOn ?? false)) === "true" : (status?.values[f.key] ?? ""),
      ]),
    ),
  );
  const [botIds, setBotIds] = useState<string[] | null>(status?.botIds ?? null);
  const [confirm, setConfirm] = useState(false);
  const refresh = () => void qc.invalidateQueries({ queryKey: ["connectors"] });

  const save = useMutation({
    mutationFn: () => saveConnector(def.id, values, botIds),
    onSuccess: () => {
      refresh();
      toast({ title: connected ? `${def.name} updated` : `${def.name} connected`, description: "Bots get it on their next message." });
    },
    onError: (err) => toast({ title: "Not saved", description: err instanceof Error ? err.message : undefined, variant: "destructive" }),
  });
  const access = useMutation({
    mutationFn: (ids: string[] | null) => setConnectorBots(def.id, ids),
    onSuccess: refresh,
    onError: (err) => toast({ title: "Not saved", description: err instanceof Error ? err.message : undefined, variant: "destructive" }),
  });
  const remove = useMutation({
    mutationFn: () => disconnectConnector(def.id),
    onSuccess: () => {
      refresh();
      onDisconnected();
    },
    onError: (err) => toast({ title: "Could not disconnect", description: err instanceof Error ? err.message : undefined, variant: "destructive" }),
  });

  const missing = def.fields.some(
    (f) => f.type !== "toggle" && !f.optional && !String(values[f.key] ?? "").trim() && !(f.type === "secret" && status?.secretsSet.includes(f.key)),
  );

  return (
    <div className="space-y-4">
      {def.steps && (
        <ol className="list-decimal space-y-1.5 rounded-2xl border border-border bg-card/60 py-3.5 pr-4 pl-9 text-[12.5px] text-muted-foreground">
          {def.steps.map((s, i) => (
            <li key={i}>
              {s.text}
              {s.url && (
                <>
                  {" — "}
                  <button
                    type="button"
                    onClick={() => void openExternal(s.url!)}
                    className="inline-flex items-center gap-0.5 underline underline-offset-2 hover:text-foreground"
                  >
                    {s.label ?? "open"}
                    <ExternalLink className="h-3 w-3" />
                  </button>
                </>
              )}
            </li>
          ))}
        </ol>
      )}

      <div className="space-y-3">
        {def.fields.map((f) =>
          f.type === "toggle" ? (
            <label key={f.key} className="flex cursor-pointer items-start gap-2.5">
              <input
                type="checkbox"
                checked={values[f.key] === true}
                onChange={(e) => setValues({ ...values, [f.key]: e.target.checked })}
                className="mt-0.5"
              />
              <span>
                <span className="block text-[12.5px] font-medium">{f.label}</span>
                {f.help && <span className="block text-[12px] text-muted-foreground">{f.help}</span>}
              </span>
            </label>
          ) : (
            <label key={f.key} className="block space-y-1">
              <span className="block text-[12.5px] font-medium">{f.label}</span>
              <input
                className={field}
                type={f.type === "secret" ? "password" : "text"}
                value={String(values[f.key] ?? "")}
                onChange={(e) => setValues({ ...values, [f.key]: e.target.value })}
                placeholder={f.type === "secret" && status?.secretsSet.includes(f.key) ? "Saved — type to replace" : f.placeholder}
                spellCheck={false}
                autoComplete="off"
              />
              {f.help && <span className="block text-[12px] text-muted-foreground">{f.help}</span>}
            </label>
          ),
        )}
      </div>

      <BotAccess
        value={botIds}
        onChange={(v) => {
          setBotIds(v);
          if (connected) access.mutate(v);
        }}
      />

      <div className="flex items-center justify-between gap-2 pt-1">
        {connected ? (
          <Button size="sm" variant="ghost" className="text-destructive" onClick={() => setConfirm(true)}>
            <Trash2 className="h-3.5 w-3.5" />
            Disconnect
          </Button>
        ) : (
          <span className="text-[11.5px] text-muted-foreground">Stored encrypted on this Mac. It goes into the computers of the bots you allow, while they work — prefer read-only tokens.</span>
        )}
        <Button size="sm" disabled={missing || save.isPending} onClick={() => save.mutate()}>
          {save.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          {connected ? "Save" : "Connect"}
        </Button>
      </div>

      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title={`Disconnect ${def.name}?`}
        description="Nexus forgets the token. Bots lose this app on their next message."
        confirmLabel="Disconnect"
        onConfirm={() => remove.mutate()}
      />
    </div>
  );
}

/** Connect Apps as a dialog (the bots view). */
export function ConnectAppsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="gap-0 p-0 sm:max-w-[880px]">
        <DialogTitle className="px-8 pt-7 pb-4 text-[19px] font-semibold">Connect Apps</DialogTitle>
        <ConnectApps className="max-h-[72vh] overflow-y-auto px-8 pb-8" />
      </DialogContent>
    </Dialog>
  );
}
