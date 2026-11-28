"use client";

// "Add your AWS / Civo key" — or a GitHub / GitLab token — inside a project
// chat (spec 39). The form posts the key straight to Nexus — it never goes
// through the chat or the model — tests it, and only then tells the chat to
// carry on. "Open in Vault" goes to the same place in Settings instead.

import { useState } from "react";
import { BadgeCheck, Check, Cloud, ExternalLink, Loader2, Lock, ShieldCheck, SlidersHorizontal } from "lucide-react";
import { siCivo, siGithub, siGitlab } from "simple-icons";

import { BotAvatar } from "@/components/bots/bot-avatar";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import type { CardProvider } from "@/lib/nexus-cards";
import { cn } from "@/lib/utils";
import { openExternal } from "@/services/updates";

const FIELDS: Record<
  CardProvider,
  {
    label: string;
    noun: string;
    /** "Let Nexus …": what connecting it allows. */
    lets: string;
    fields: { key: string; label: string; secret: boolean }[];
    help: string;
    /** Where to make one, opened in the browser. */
    createUrl?: string;
    /** The Vault section that holds it. */
    vaultTab: "cloud" | "git";
  }
> = {
  aws: {
    label: "AWS",
    fields: [
      { key: "accessKeyId", label: "Access key ID", secret: false },
      { key: "secretAccessKey", label: "Secret access key", secret: true },
    ],
    help: "An IAM user's access key with EC2 permissions (IAM → Users → Security credentials).",
    noun: "key",
    lets: "launch sandboxes on EC2",
    vaultTab: "cloud",
  },
  civo: {
    label: "Civo",
    fields: [{ key: "token", label: "API key", secret: true }],
    help: "Your Civo API key (dashboard → Settings → Profile → Security).",
    noun: "key",
    lets: "launch sandboxes on Civo",
    vaultTab: "cloud",
  },
  github: {
    label: "GitHub",
    fields: [{ key: "token", label: "Token (github_pat_… or ghp_…)", secret: true }],
    help: "A token that can read the project's repositories — a fine-grained one with Contents: read (and write, to push) on them.",
    noun: "token",
    lets: "read your repositories on GitHub",
    createUrl: "https://github.com/settings/personal-access-tokens/new",
    vaultTab: "git",
  },
  gitlab: {
    label: "GitLab",
    fields: [{ key: "token", label: "Token (glpat-…)", secret: true }],
    help: "A personal access token with read_repository (and write_repository, to push).",
    noun: "token",
    lets: "read your repositories on GitLab",
    createUrl: "https://gitlab.com/-/user_settings/personal_access_tokens",
    vaultTab: "git",
  },
};

export function CredentialCard({
  provider,
  disabled,
  onSaved,
  projectId,
  onOpenVault,
  botName = "Nexus",
  bot,
}: {
  provider: CardProvider;
  disabled: boolean;
  onSaved: (message: string) => void;
  /** A git token is also checked against this project's repositories. */
  projectId?: string | null;
  /** Open Settings on the Vault section that holds this kind of key. */
  onOpenVault?: (tab: "cloud" | "git") => void;
  /** Who gets to use it, for "Let … use GitHub". */
  botName?: string;
  /** The chat's face, shown connecting to the app. */
  bot?: { shape: string; color: string };
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
      const git = spec.vaultTab === "git";
      const check = await fetch(`/api/credentials/${body.id}/check${git && projectId ? `?projectId=${projectId}` : ""}`, { method: "POST" })
        .then((r) => r.json())
        .catch(() => null);
      if (check?.status === "fail") {
        const why =
          (check.checks as { ok: boolean | null; detail?: string; label?: string }[] | undefined)?.find((c) => c.ok === false)
            ?.detail ?? "the provider refused it";
        throw new Error(`Saved, but the test failed: ${why}. Fix it in Vault → ${git ? "Git" : "Cloud"}, or paste another ${spec.noun} here.`);
      }
      setValues({});
      setConnected(true);
      setOpen(false);
      onSaved(`I saved a ${spec.label} ${spec.noun} ("${name.trim()}")${check?.status ? " and it passed the test" : ""}. Continue.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<"intro" | "form">("intro");
  const [connected, setConnected] = useState(false);
  const openDialog = () => {
    setStep("intro");
    setError(null);
    setOpen(true);
  };

  return (
    <div className="w-full max-w-[560px] space-y-1.5">
      {/* The app, and what connecting lets the chat do — like any app connect. */}
      <div className="flex items-center gap-3 rounded-2xl border border-border bg-card px-3.5 py-3">
        <ProviderLogo provider={provider} />
        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-1.5 text-[13.5px] font-medium">
            {spec.label}
            <BadgeCheck className="h-3.5 w-3.5 fill-sky-500 text-card" aria-label="Official" />
          </p>
          <p className="truncate text-[12px] text-muted-foreground">
            Let {botName} {spec.lets}
          </p>
        </div>
        {connected ? (
          <span className="flex shrink-0 items-center gap-1 rounded-full border border-emerald-500/30 px-3 py-1 text-[12px] text-emerald-300">
            <Check className="h-3.5 w-3.5" />
            Connected
          </span>
        ) : (
          <button
            type="button"
            disabled={disabled}
            onClick={openDialog}
            className="shrink-0 rounded-full bg-foreground px-3.5 py-1.5 text-[12.5px] font-medium text-background transition-opacity hover:opacity-85 disabled:opacity-50"
          >
            Connect
          </button>
        )}
      </div>
      <p className="px-2 text-[11px] text-muted-foreground">
        {botName} only gets what you allow. Remove it from the Vault at any time.
      </p>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="gap-0 p-6 sm:max-w-[440px]">
          {/* Who connects to what: the bot's face, a dotted link, the app. */}
          <div className="flex items-center justify-center gap-3 pt-2">
            {bot ? <BotAvatar shape={bot.shape} color={bot.color} size={52} looking /> : null}
            <span className="flex gap-1" aria-hidden>
              {[0, 1, 2].map((i) => (
                <span key={i} className="h-1 w-1 rounded-full bg-muted-foreground/60" />
              ))}
            </span>
            <ProviderLogo provider={provider} size="lg" />
          </div>
          <DialogTitle className="pt-4 text-center text-[19px] leading-snug font-medium">Connect to {spec.label}</DialogTitle>
          <DialogDescription className="pt-1 text-center text-[13px]">
            Let {botName} {spec.lets} on your behalf
          </DialogDescription>

          {step === "intro" ? (
            <>
              <ul className="mt-5 divide-y divide-border/60 rounded-xl border border-border bg-background/30">
                <Assurance icon={Lock} title={`Your ${spec.noun} stays on this Mac`} detail={`Saved in your Vault — ${botName} never shows it in the chat`} />
                <Assurance icon={SlidersHorizontal} title={`You decide what ${botName} can do`} detail={`It only gets what the ${spec.noun} allows${spec.vaultTab === "git" ? " — read access is enough" : ""}`} />
                <Assurance icon={ShieldCheck} title="You're in control" detail={`Remove the connection to ${spec.label} at any time`} />
              </ul>
              <p className="pt-4 text-center text-[11.5px] text-muted-foreground">
                Manage connections anytime from{" "}
                {onOpenVault ? (
                  <button
                    type="button"
                    onClick={() => {
                      setOpen(false);
                      onOpenVault(spec.vaultTab);
                    }}
                    className="underline-offset-2 hover:text-foreground hover:underline"
                  >
                    Settings → Vault
                  </button>
                ) : (
                  "Settings → Vault"
                )}
              </p>
              <button
                type="button"
                onClick={() => setStep("form")}
                className="mt-4 h-10 w-full rounded-full bg-foreground text-[13.5px] font-medium text-background transition-opacity hover:opacity-85"
              >
                Continue
              </button>
            </>
          ) : (
            <form
              className="mt-5 animate-in space-y-2.5 duration-200 fade-in slide-in-from-right-2"
              onSubmit={(e) => {
                e.preventDefault();
                if (ready && !busy && !disabled) void save();
              }}
            >
              <p className="text-[12.5px] text-muted-foreground">
                {spec.help}{" "}
                {spec.createUrl && (
                  <button
                    type="button"
                    onClick={() => void openExternal(spec.createUrl!)}
                    className="inline-flex items-center gap-0.5 text-violet-300 underline-offset-2 hover:text-violet-200 hover:underline"
                  >
                    Create one on {spec.label}
                    <ExternalLink className="h-3 w-3" />
                  </button>
                )}
              </p>
              {spec.fields.map((f, idx) => (
                <input
                  key={f.key}
                  autoFocus={idx === 0}
                  type={f.secret ? "password" : "text"}
                  autoComplete="off"
                  spellCheck={false}
                  value={values[f.key] ?? ""}
                  onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
                  placeholder={f.label}
                  className="h-10 w-full rounded-xl border border-input bg-transparent px-3 font-mono text-[12.5px] outline-none focus:border-ring"
                />
              ))}
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Name it (e.g. Work account)"
                aria-label="Name"
                className="h-9 w-full rounded-xl border border-input bg-transparent px-3 text-[12.5px] outline-none focus:border-ring"
              />
              {error && <p className="text-[12px] text-destructive">{error}</p>}
              <div className="flex gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setStep("intro")}
                  className="h-10 rounded-full px-4 text-[13px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                >
                  Back
                </button>
                <button
                  type="submit"
                  disabled={busy || !ready}
                  className="flex h-10 flex-1 items-center justify-center gap-1.5 rounded-full bg-foreground text-[13.5px] font-medium text-background transition-opacity hover:opacity-85 disabled:opacity-40"
                >
                  {busy && <Loader2 className="h-4 w-4 animate-spin" />}
                  {busy ? "Checking…" : "Connect"}
                </button>
              </div>
            </form>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function Assurance({ icon: Icon, title, detail }: { icon: typeof Lock; title: string; detail: string }) {
  return (
    <li className="flex gap-3 px-4 py-3">
      <Icon className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0">
        <p className="text-[13px]">{title}</p>
        <p className="text-[12px] text-muted-foreground">{detail}</p>
      </div>
    </li>
  );
}

/** The provider's own mark on its brand colour (AWS has none in simple-icons: a cloud on its orange). */
function ProviderLogo({ provider, size = "md" }: { provider: CardProvider; size?: "md" | "lg" }) {
  const mark = { github: siGithub, gitlab: siGitlab, civo: siCivo }[provider as "github" | "gitlab" | "civo"];
  const bg = provider === "aws" ? "#232F3E" : "#ffffff";
  return (
    <span
      className={cn("flex shrink-0 items-center justify-center border border-border/60", size === "lg" ? "h-14 w-14 rounded-2xl" : "h-11 w-11 rounded-xl")}
      style={{ background: bg }}
    >
      {mark ? (
        <svg viewBox="0 0 24 24" className={size === "lg" ? "h-8 w-8" : "h-6 w-6"} fill={`#${mark.hex}`} aria-hidden>
          <path d={mark.path} />
        </svg>
      ) : (
        <Cloud className={cn("text-[#FF9900]", size === "lg" ? "h-8 w-8" : "h-6 w-6")} />
      )}
    </span>
  );
}
