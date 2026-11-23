"use client";

// New / edit a vault entry (spec 32). On edit the secret fields start blank:
// the stored values never come back to the browser, and blank means "keep".

import { useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Copy, Eye, EyeOff, Info, Loader2, Plus, Trash2, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import { SECRET_NAME, type PublicVaultItem, type VaultCreateInput, type VaultType } from "@/lib/vault-items";
import { getBots } from "@/services/bots";
import { createVaultItem, deleteVaultItem, updateVaultItem } from "@/services/vault";
import { VAULT_TYPE_META } from "@/components/vault/vault-meta";

const field =
  "w-full rounded-lg border border-input bg-transparent px-3 py-2 text-[13px] outline-none placeholder:text-muted-foreground focus:border-ring";

export function VaultItemDialog({ type, item, onClose }: { type: VaultType; item: PublicVaultItem | null; onClose: () => void }) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const editing = Boolean(item);
  const keep = editing ? "Leave blank to keep the saved one" : undefined;

  const [name, setName] = useState(item?.name ?? "");
  const [websites, setWebsites] = useState<string[]>(item?.websites.length ? item.websites : [""]);
  const [username, setUsername] = useState(item?.username ?? "");
  const [hint, setHint] = useState(item?.hint ?? "");
  const [botIds, setBotIds] = useState<string[] | null>(item?.botIds ?? null);
  const [secret, setSecret] = useState<Record<string, string>>({});
  const [confirmDelete, setConfirmDelete] = useState(false);
  const set = (k: string) => (v: string) => setSecret((s) => ({ ...s, [k]: v }));

  const done = () => {
    qc.invalidateQueries({ queryKey: ["vault"] });
    onClose();
  };
  const fail = (title: string) => (err: unknown) =>
    toast({ title, description: err instanceof Error ? err.message : undefined, variant: "destructive" });

  const save = useMutation({
    mutationFn: async () => {
      const sites = websites.map((w) => w.trim()).filter(Boolean);
      if (item) {
        return updateVaultItem(item.id, {
          name: type === "login" ? undefined : name.trim(),
          websites: type === "login" ? sites : undefined,
          username: type === "login" ? username : undefined,
          hint,
          botIds,
          secret,
        });
      }
      const common = { hint: hint || null, botIds };
      const input: VaultCreateInput =
        type === "login"
          ? { type, websites: sites, username: username || null, secret: { password: secret.password ?? "" }, ...common }
          : type === "secret"
            ? { type, name: name.trim(), secret: { value: secret.value ?? "" }, ...common }
            : type === "card"
              ? {
                  type,
                  name: name.trim() || undefined,
                  secret: { number: secret.number ?? "", expiry: secret.expiry ?? "", cvc: secret.cvc ?? "", holder: secret.holder ?? "" },
                  ...common,
                }
              : { type, name: name.trim(), secret: { email: secret.email, phone: secret.phone, address: secret.address }, ...common };
      return createVaultItem(input);
    },
    onSuccess: () => {
      toast({ title: editing ? "Saved" : "Added to the vault" });
      done();
    },
    onError: fail("Could not save"),
  });
  const remove = useMutation({
    mutationFn: () => deleteVaultItem(item!.id),
    onSuccess: done,
    onError: fail("Could not delete"),
  });

  const M = VAULT_TYPE_META[type];
  const canSave = (() => {
    if (save.isPending) return false;
    if (type === "login") return websites.some((w) => w.trim()) && (editing || Boolean(secret.password));
    if (type === "secret") return SECRET_NAME.test(name.trim()) && (editing || Boolean(secret.value));
    if (type === "card") return editing || ["number", "expiry", "cvc", "holder"].every((k) => secret[k]?.trim());
    return Boolean(name.trim()) && (editing || ["email", "phone", "address"].some((k) => secret[k]?.trim()));
  })();

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="gap-0 overflow-hidden p-0 sm:max-w-[460px]">
        <DialogHeader className="border-b border-border px-5 py-3.5">
          <DialogTitle className="flex items-center gap-2 text-[14px] font-semibold">
            <M.icon className="h-4 w-4" />
            {editing ? item!.name : `New ${M.label.toLowerCase()}`}
          </DialogTitle>
        </DialogHeader>
        <form
          className="max-h-[70vh] space-y-4 overflow-y-auto px-5 pt-4 pb-5"
          onSubmit={(e) => {
            e.preventDefault();
            if (canSave) save.mutate();
          }}
        >
          {type === "login" && (
            <>
              <Field label="Website">
                <div className="space-y-2">
                  {websites.map((w, i) => (
                    <div key={i} className="flex items-center gap-2">
                      <input
                        className={field}
                        value={w}
                        autoFocus={!editing && i === 0}
                        placeholder="example.com"
                        onChange={(e) => setWebsites(websites.map((x, j) => (j === i ? e.target.value : x)))}
                      />
                      {websites.length > 1 && (
                        <button type="button" aria-label="Remove website" onClick={() => setWebsites(websites.filter((_, j) => j !== i))} className="text-muted-foreground hover:text-foreground">
                          <X className="h-4 w-4" />
                        </button>
                      )}
                    </div>
                  ))}
                  <button
                    type="button"
                    onClick={() => setWebsites([...websites, ""])}
                    className="inline-flex items-center gap-1.5 rounded-full bg-accent px-3 py-1 text-[12px] text-foreground/80 hover:text-foreground"
                  >
                    <Plus className="h-3 w-3" />
                    Add website
                  </button>
                </div>
              </Field>
              <Field label="Username or email" optional>
                <input className={field} value={username} placeholder="name@example.com" autoComplete="off" onChange={(e) => setUsername(e.target.value)} />
              </Field>
              <Field label="Password">
                <SecretInput value={secret.password ?? ""} onChange={set("password")} placeholder={keep} autoComplete="new-password" />
              </Field>
            </>
          )}

          {type === "secret" && (
            <>
              <Field label="Name" hint={<RefHint name={name} />}>
                <input className={cn(field, "font-mono")} value={name} autoFocus={!editing} placeholder="mongo-readonly" onChange={(e) => setName(e.target.value)} />
              </Field>
              <Field label="Value">
                <SecretInput value={secret.value ?? ""} onChange={set("value")} placeholder={keep ?? "mongodb+srv://… · sk-… · token"} />
              </Field>
            </>
          )}

          {type === "card" && (
            <>
              <Field label="Name on card">
                <input className={field} value={secret.holder ?? ""} autoFocus={!editing} placeholder={keep ?? "Alex Doe"} autoComplete="off" onChange={(e) => set("holder")(e.target.value)} />
              </Field>
              <Field label="Card number">
                <SecretInput value={secret.number ?? ""} onChange={set("number")} placeholder={keep ?? "4242 4242 4242 4242"} inputMode="numeric" />
              </Field>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Expiry">
                  <input className={field} value={secret.expiry ?? ""} placeholder={editing ? "Keep" : "MM/YY"} autoComplete="off" onChange={(e) => set("expiry")(e.target.value)} />
                </Field>
                <Field label="CVC">
                  <SecretInput value={secret.cvc ?? ""} onChange={set("cvc")} placeholder={editing ? "Keep" : "123"} inputMode="numeric" />
                </Field>
              </div>
              <Field label="Nickname" optional>
                <input className={field} value={name} placeholder="Company Visa" onChange={(e) => setName(e.target.value)} />
              </Field>
            </>
          )}

          {type === "contact" && (
            <>
              <Field label="Name">
                <input className={field} value={name} autoFocus={!editing} placeholder="Office" onChange={(e) => setName(e.target.value)} />
              </Field>
              <Field label="Email" optional>
                <SecretInput value={secret.email ?? ""} onChange={set("email")} placeholder={keep ?? "hello@example.com"} plain />
              </Field>
              <Field label="Phone" optional>
                <SecretInput value={secret.phone ?? ""} onChange={set("phone")} placeholder={keep ?? "+57 300 000 0000"} plain />
              </Field>
              <Field label="Address" optional>
                <SecretInput value={secret.address ?? ""} onChange={set("address")} placeholder={keep ?? "Street, city, country"} plain />
              </Field>
            </>
          )}

          <Field label="Hints" optional hint="Tell bots when to use this entry">
            <input className={field} value={hint} placeholder={type === "secret" ? "Read-only user for the customers database" : "The company's ad account"} onChange={(e) => setHint(e.target.value)} />
          </Field>

          <BotAccess value={botIds} onChange={setBotIds} />

          <p className="flex items-start gap-2 rounded-xl bg-accent/60 px-3 py-2.5 text-[12px] text-foreground/80">
            <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            {type === "login" && "Bots can sign in with this login. Nexus types the password for them — they never see it, and only on these websites."}
            {type === "secret" && "Use it in a bot's MCP servers as {{secret:name}}. It is filled in when the bot's computer gets its config, and never shown in settings or chats."}
            {type === "card" && "Bots can pay with this card on https pages, and are told to confirm the merchant and amount with you first."}
            {type === "contact" && "Bots can fill forms with these details. Nexus types them in."}
          </p>

          <div className="flex items-center justify-between pt-1">
            {editing ? (
              <Button type="button" variant="ghost" size="sm" className="text-destructive hover:text-destructive" onClick={() => setConfirmDelete(true)}>
                <Trash2 className="h-3.5 w-3.5" />
                Delete
              </Button>
            ) : (
              <span />
            )}
            <Button type="submit" size="sm" className="rounded-full px-4" disabled={!canSave}>
              {save.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              {editing ? "Save" : `Save ${M.label.toLowerCase()}`}
            </Button>
          </div>
        </form>
        <ConfirmDialog
          open={confirmDelete}
          onOpenChange={setConfirmDelete}
          title={`Delete “${item?.name}”?`}
          description="Bots that use it lose access. This can't be undone."
          onConfirm={() => remove.mutate()}
        />
      </DialogContent>
    </Dialog>
  );
}

function Field({ label, optional, hint, children }: { label: string; optional?: boolean; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="block space-y-1.5">
      <span className="block text-[12.5px] font-medium">
        {label} {optional && <span className="font-normal text-muted-foreground">(Optional)</span>}
      </span>
      {children}
      {hint && <span className="block text-[11.5px] text-muted-foreground">{hint}</span>}
    </label>
  );
}

/** A masked input with a reveal toggle — for what is being typed now, not what is stored. */
function SecretInput({
  value,
  onChange,
  placeholder,
  plain,
  autoComplete = "off",
  inputMode,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  plain?: boolean;
  autoComplete?: string;
  inputMode?: "numeric";
}) {
  const [show, setShow] = useState(false);
  return (
    <div className="relative">
      <input
        className={cn(field, !plain && "pr-9")}
        type={plain || show ? "text" : "password"}
        value={value}
        placeholder={placeholder}
        autoComplete={autoComplete}
        inputMode={inputMode}
        spellCheck={false}
        onChange={(e) => onChange(e.target.value)}
      />
      {!plain && (
        <button
          type="button"
          aria-label={show ? "Hide" : "Show"}
          onClick={() => setShow(!show)}
          className="absolute top-1/2 right-2.5 -translate-y-1/2 text-muted-foreground hover:text-foreground"
        >
          {show ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
        </button>
      )}
    </div>
  );
}

function RefHint({ name }: { name: string }) {
  const [copied, setCopied] = useState(false);
  const ref = `{{secret:${name.trim() || "name"}}}`;
  return (
    <span className="flex items-center gap-1.5">
      In MCP configs: <code className="font-mono text-foreground/80">{ref}</code>
      {name.trim() && (
        <button
          type="button"
          aria-label="Copy reference"
          onClick={async () => {
            await navigator.clipboard.writeText(ref).catch(() => {});
            setCopied(true);
            setTimeout(() => setCopied(false), 1200);
          }}
          className="hover:text-foreground"
        >
          {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
        </button>
      )}
    </span>
  );
}

/** Which bots may use the entry: every bot, or the ones picked. */
export function BotAccess({ value, onChange }: { value: string[] | null; onChange: (v: string[] | null) => void }) {
  const { data: bots } = useQuery({ queryKey: ["bots"], queryFn: getBots });
  if (!bots?.length) return null;
  const all = value === null;
  return (
    <div className="space-y-1.5">
      <span className="block text-[12.5px] font-medium">Bots that can use it</span>
      <div className="flex flex-wrap gap-1.5">
        <Chip active={all} onClick={() => onChange(null)}>
          All bots
        </Chip>
        {bots.map((b) => {
          const on = !all && value.includes(b.id);
          return (
            <Chip
              key={b.id}
              active={on}
              onClick={() => {
                const next = all ? [b.id] : on ? value.filter((x) => x !== b.id) : [...value, b.id];
                onChange(next.length ? next : null);
              }}
            >
              <span className="h-2 w-2 rounded-full" style={{ background: b.color }} />
              {b.name}
            </Chip>
          );
        })}
      </div>
    </div>
  );
}

function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[12px] transition-colors",
        active ? "border-foreground/30 bg-accent text-foreground" : "border-border text-muted-foreground hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}
