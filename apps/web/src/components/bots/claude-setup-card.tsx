"use client";

// A fresh Nexus has no Claude Code token, and the first message fails on it.
// Instead of a red error line the chat shows this: what is missing, the one
// command that gets it, and a field to paste it. Saved straight to the
// credentials store (never through the chat or the model), then the message is sent again.

import { useState } from "react";
import { Check, Copy, Loader2, Terminal } from "lucide-react";
import { siClaude } from "simple-icons";

import { looksLikeClaudeToken } from "@/lib/claude-setup";
import { cn } from "@/lib/utils";

const COMMAND = "claude setup-token";

export function ClaudeSetupCard({
  color,
  disabled,
  onSaved,
}: {
  /** The bot's colour, for the main button. */
  color: string;
  disabled: boolean;
  /** Token saved: send the failed message again. */
  onSaved: () => void;
}) {
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [done, setDone] = useState(false);
  const shapeOk = looksLikeClaudeToken(token);

  const copy = () => {
    void navigator.clipboard?.writeText(COMMAND).catch(() => undefined);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const save = async () => {
    if (!token.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/credentials", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider: "claude", name: "Claude Code", token: token.trim() }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(typeof body.error === "string" ? body.error : "Could not save the token");
      setToken("");
      setDone(true);
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  if (done) {
    return (
      <div className="flex max-w-[560px] items-center gap-2.5 rounded-2xl border border-border bg-card/60 px-4 py-3 text-[13px]">
        <span className="flex h-5 w-5 items-center justify-center rounded-full bg-emerald-500/15">
          <Check className="h-3 w-3 text-emerald-400" />
        </span>
        Claude Code is connected — sending your message again.
      </div>
    );
  }

  return (
    <div className="w-full max-w-[560px] animate-in rounded-2xl border border-border bg-card px-4 pt-4 pb-3.5 duration-300 fade-in slide-in-from-bottom-1">
      <div className="flex items-start gap-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-[#D97757]/15">
          <svg viewBox="0 0 24 24" className="h-4.5 w-4.5" fill={`#${siClaude.hex}`} aria-hidden>
            <path d={siClaude.path} />
          </svg>
        </span>
        <div className="min-w-0">
          <p className="text-[13.5px] font-semibold">Connect Claude Code to start</p>
          <p className="mt-0.5 text-[12.5px] leading-relaxed text-muted-foreground">
            Nexus and your bots think with your Claude subscription. It takes one command — your message is waiting and goes out as
            soon as it&apos;s connected.
          </p>
        </div>
      </div>

      <ol className="mt-4 space-y-3 text-[12.5px]">
        <li className="flex gap-3">
          <Step n={1} />
          <div className="min-w-0 flex-1">
            <p>In a terminal on this Mac, run this and sign in:</p>
            <div className="mt-1.5 flex items-center gap-2 rounded-lg border border-border bg-background/60 py-1.5 pr-1.5 pl-2.5 font-mono text-[12px]">
              <Terminal className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <span className="flex-1 select-all">{COMMAND}</span>
              <button
                type="button"
                onClick={copy}
                className="flex h-6 items-center gap-1 rounded-md px-1.5 text-[11px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              >
                {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
                {copied ? "Copied" : "Copy"}
              </button>
            </div>
          </div>
        </li>
        <li className="flex gap-3">
          <Step n={2} />
          <form
            className="min-w-0 flex-1"
            onSubmit={(e) => {
              e.preventDefault();
              void save();
            }}
          >
            <p>
              Paste the token it prints <span className="text-muted-foreground">(sk-ant-oat…)</span>:
            </p>
            <div className="mt-1.5 flex gap-2">
              <input
                type="password"
                value={token}
                disabled={disabled || busy}
                onChange={(e) => {
                  setToken(e.target.value);
                  setError(null);
                }}
                placeholder="sk-ant-oat01-…"
                autoComplete="off"
                spellCheck={false}
                className={cn(
                  "h-9 min-w-0 flex-1 rounded-lg border bg-transparent px-2.5 font-mono text-[12px] outline-none focus:border-ring",
                  token && !shapeOk ? "border-amber-500/50" : "border-input",
                )}
              />
              <button
                type="submit"
                disabled={disabled || busy || !token.trim()}
                className="flex h-9 shrink-0 items-center gap-1.5 rounded-lg px-3.5 text-[12.5px] font-medium text-white transition-opacity disabled:opacity-40"
                style={{ background: color }}
              >
                {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                Connect
              </button>
            </div>
            {token && !shapeOk && !error && (
              <p className="mt-1 text-[11.5px] text-amber-400/90">That doesn&apos;t look like a setup-token token — check you copied all of it.</p>
            )}
            {error && <p className="mt-1 text-[11.5px] text-destructive">{error}</p>}
          </form>
        </li>
      </ol>
      <p className="mt-3 border-t border-border/60 pt-2.5 text-[11px] text-muted-foreground">
        Saved on this Mac, in Vault → AI providers. It goes straight there — never through the chat.
      </p>
    </div>
  );
}

function Step({ n }: { n: number }) {
  return (
    <span className="mt-px flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-border text-[10.5px] text-muted-foreground">
      {n}
    </span>
  );
}
