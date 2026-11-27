"use client";

// "Add your AWS / Civo key" inside a project chat (spec 39). The form posts the
// key straight to Nexus — it never goes through the chat or the model — tests
// it, and only then tells the chat to carry on.

import { useState } from "react";
import { KeyRound, Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import type { CardProvider } from "@/lib/nexus-cards";

const FIELDS: Record<CardProvider, { label: string; fields: { key: string; label: string; secret: boolean }[]; help: string }> = {
  aws: {
    label: "AWS",
    fields: [
      { key: "accessKeyId", label: "Access key ID", secret: false },
      { key: "secretAccessKey", label: "Secret access key", secret: true },
    ],
    help: "An IAM user's access key with EC2 permissions (IAM → Users → Security credentials).",
  },
  civo: {
    label: "Civo",
    fields: [{ key: "token", label: "API key", secret: true }],
    help: "Your Civo API key (dashboard → Settings → Profile → Security).",
  },
};

export function CredentialCard({
  provider,
  disabled,
  onSaved,
}: {
  provider: CardProvider;
  disabled: boolean;
  onSaved: (message: string) => void;
}) {
  const spec = FIELDS[provider];
  const [name, setName] = useState(`${spec.label} account`);
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ready = name.trim() && spec.fields.every((f) => values[f.key]?.trim());

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/credentials", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          provider,
          name: name.trim(),
          ...Object.fromEntries(spec.fields.map((f) => [f.key, values[f.key]!.trim()])),
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(typeof body.error === "string" ? body.error : "Could not save the key");
      // Try it before carrying on: a wrong key found now beats a failed launch later.
      const check = await fetch(`/api/credentials/${body.id}/check`, { method: "POST" })
        .then((r) => r.json())
        .catch(() => null);
      if (check?.status === "fail") {
        const why =
          (check.checks as { ok: boolean | null; detail?: string; label?: string }[] | undefined)?.find((c) => c.ok === false)
            ?.detail ?? "the provider refused it";
        throw new Error(`Saved, but the test failed: ${why}. Fix it in Vault → Cloud, or paste another key here.`);
      }
      setValues({});
      onSaved(`I saved a ${spec.label} credential ("${name.trim()}")${check?.status ? " and it passed the test" : ""}. Continue.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="max-w-[560px] rounded-2xl border border-border bg-card px-4 py-3.5">
      <p className="flex items-center gap-2 text-[13.5px] font-semibold">
        <KeyRound className="h-4 w-4 text-muted-foreground" />
        Add your {spec.label} key
      </p>
      <p className="pt-1 text-[12px] text-muted-foreground">
        {spec.help} It goes straight to your Vault, encrypted — the chat never sees it.
      </p>
      <form
        className="space-y-2 pt-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (ready && !busy && !disabled) void save();
        }}
      >
        <input
          value={name}
          disabled={disabled}
          onChange={(e) => setName(e.target.value)}
          placeholder="Name"
          className="h-9 w-full rounded-lg border border-input bg-transparent px-2.5 text-[12.5px] outline-none focus:border-ring"
        />
        {spec.fields.map((f) => (
          <input
            key={f.key}
            type={f.secret ? "password" : "text"}
            autoComplete="off"
            value={values[f.key] ?? ""}
            disabled={disabled}
            onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
            placeholder={f.label}
            className="h-9 w-full rounded-lg border border-input bg-transparent px-2.5 font-mono text-[12px] outline-none focus:border-ring"
          />
        ))}
        {error && <p className="text-[12px] text-destructive">{error}</p>}
        <Button type="submit" size="sm" className="rounded-full" disabled={disabled || busy || !ready}>
          {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          Save and continue
        </Button>
      </form>
    </div>
  );
}
