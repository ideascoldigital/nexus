"use client";

// The vault (spec 32): what bots use without reading it — logins they sign in
// with, secrets their MCP servers take ({{secret:name}}), cards, contact
// details. Lists show the public part; a secret is entered, replaced or
// deleted, never shown again.

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, Lock, Search, ShieldCheck } from "lucide-react";

import { VaultItemDialog } from "@/components/vault/vault-item-dialog";
import { VAULT_TYPE_META } from "@/components/vault/vault-meta";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { PublicVaultItem, VaultType } from "@/lib/vault-items";
import { cn } from "@/lib/utils";
import { listVault } from "@/services/vault";


const FILTERS: Array<VaultType | "all"> = ["all", "login", "secret", "card", "contact"];

export function VaultSection({ className }: { className?: string }) {
  const { data: items, isLoading } = useQuery({ queryKey: ["vault"], queryFn: listVault });
  const [filter, setFilter] = useState<VaultType | "all">("all");
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<PublicVaultItem | null>(null);
  const [creating, setCreating] = useState<VaultType | null>(null);

  const count = (t: VaultType | "all") => (items ?? []).filter((i) => t === "all" || i.type === t).length;
  const q = query.trim().toLowerCase();
  const shown = (items ?? []).filter(
    (i) =>
      (filter === "all" || i.type === filter) &&
      (!q || [i.name, i.username, i.label, i.hint, ...i.websites].some((s) => s?.toLowerCase().includes(q))),
  );

  return (
    <div className={cn("space-y-4", className)}>
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex flex-wrap gap-1">
          {FILTERS.map((f) => (
            <button
              key={f}
              type="button"
              onClick={() => setFilter(f)}
              className={cn(
                "rounded-full px-3 py-1.5 text-[13px] transition-colors",
                filter === f ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground",
              )}
            >
              {f === "all" ? "All" : VAULT_TYPE_META[f].plural} <span className="text-muted-foreground">{count(f)}</span>
            </button>
          ))}
        </div>
        <div className="ml-auto flex items-center gap-2">
          <label className="flex h-9 w-44 items-center gap-2 rounded-full border border-border bg-background/40 px-3 focus-within:border-foreground/25">
            <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search vault"
              className="min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-muted-foreground"
            />
          </label>
          <DropdownMenu>
            <DropdownMenuTrigger className="flex h-9 items-center gap-1.5 rounded-full bg-foreground px-4 text-[13px] font-medium text-background transition-opacity hover:opacity-85">
              New item
              <ChevronDown className="h-3.5 w-3.5" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-60">
              {(Object.keys(VAULT_TYPE_META) as VaultType[]).map((t) => {
                const M = VAULT_TYPE_META[t];
                return (
                  <DropdownMenuItem key={t} onClick={() => setCreating(t)} className="items-start gap-2.5 py-2">
                    <M.icon className="mt-0.5 h-4 w-4 shrink-0" />
                    <span>
                      <span className="block text-[13px]">{M.label}</span>
                      <span className="block text-[11.5px] text-muted-foreground">{M.blurb}</span>
                    </span>
                  </DropdownMenuItem>
                );
              })}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {isLoading ? null : shown.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-2xl border border-dashed border-border px-6 py-12 text-center">
          <ShieldCheck className="h-6 w-6 text-muted-foreground" />
          <p className="text-[13.5px] font-medium">{items?.length ? "Nothing matches" : "Your vault is empty"}</p>
          <p className="max-w-sm text-[12.5px] text-muted-foreground">
            Save logins, API keys, cards and contact details once. Bots use them without ever seeing them — Nexus
            types them in, and they are encrypted on this machine with a key kept in your Keychain.
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {shown.map((i) => (
            <VaultRow key={i.id} item={i} onOpen={() => setEditing(i)} />
          ))}
        </div>
      )}

      <p className="flex items-center gap-1.5 px-1 text-[11.5px] text-muted-foreground">
        <Lock className="h-3 w-3" />
        Encrypted at rest (AES-256-GCM). Secrets can be replaced or deleted, never shown again.
      </p>

      {(creating || editing) && (
        <VaultItemDialog
          type={editing?.type ?? creating!}
          item={editing}
          onClose={() => {
            setCreating(null);
            setEditing(null);
          }}
        />
      )}
    </div>
  );
}

function VaultRow({ item, onOpen }: { item: PublicVaultItem; onOpen: () => void }) {
  const M = VAULT_TYPE_META[item.type];
  const sub =
    item.type === "login"
      ? [item.username, item.websites.length > 1 ? `${item.websites.length} websites` : null].filter(Boolean).join(" · ")
      : item.type === "secret"
        ? `{{secret:${item.name}}}`
        : item.type === "card"
          ? item.label !== item.name
            ? item.label
            : null
          : null;
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex w-full items-center gap-3 rounded-2xl border border-border bg-card/60 px-4 py-3 text-left transition-colors hover:border-foreground/20 hover:bg-card"
    >
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent text-[13px] font-semibold uppercase">
        {item.type === "login" ? item.name.charAt(0) : <M.icon className="h-4 w-4" />}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13.5px] font-medium">{item.name}</span>
        <span className={cn("block truncate text-[12px] text-muted-foreground", item.type === "secret" && "font-mono")}>
          {sub || item.hint || M.label}
        </span>
      </span>
      {item.botIds && (
        <span className="shrink-0 rounded-full bg-accent px-2 py-0.5 text-[11px] text-muted-foreground">
          {item.botIds.length} {item.botIds.length === 1 ? "bot" : "bots"}
        </span>
      )}
      <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
    </button>
  );
}
