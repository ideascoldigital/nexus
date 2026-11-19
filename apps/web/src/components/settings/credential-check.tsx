"use client";

/**
 * Test a credential in place (spec 28): a status dot from the last result, a
 * Test button, and what the provider said — account, expiry, scopes, and one
 * line per thing Nexux uses the credential for.
 */

import { useEffect, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { formatDistanceToNow } from "date-fns";
import { Check, Loader2, Minus, ShieldCheck, X } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CHECKABLE_PROVIDERS, type CredentialCheck } from "@/lib/credential-checks/types";
import { checkCredential, type CloudCredentialSummary } from "@/services/sandbox";

const DOT: Record<CredentialCheck["status"], string> = {
  ok: "bg-emerald-400",
  warn: "bg-amber-400",
  fail: "bg-destructive",
};

/** The dot and the button, for the credential's row. */
export function useCredentialCheck(
  cred: CloudCredentialSummary,
  /** Test once on mount — for a credential that was just saved (spec 28). */
  autoRun = false,
) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const run = useMutation({
    mutationFn: () => checkCredential(cred.id),
    onSuccess: () => {
      setOpen(true);
      void qc.invalidateQueries({ queryKey: ["cloud-credentials"] });
    },
    onError: () => setOpen(true),
  });
  const result = run.data ?? cred.lastCheck ?? null;
  const checkable = CHECKABLE_PROVIDERS.has(cred.provider);

  // Checked on save, so a bad value is on screen before the user walks away.
  // It never blocks saving: a self-hosted instance may be unreachable from here.
  const ran = useRef(false);
  useEffect(() => {
    if (autoRun && checkable && !ran.current) {
      ran.current = true;
      run.mutate();
    }
  }, [autoRun, checkable, run]);

  const controls = checkable ? (
    <>
      {result && (
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex items-center"
          title={`Last test: ${result.status}${cred.lastCheckedAt ? ` · ${formatDistanceToNow(new Date(cred.lastCheckedAt), { addSuffix: true })}` : ""}`}
        >
          <span className={`h-2 w-2 rounded-full ${DOT[result.status]}`} />
        </button>
      )}
      <Button
        size="sm"
        variant="ghost"
        className="h-6 px-2 text-xs"
        onClick={() => run.mutate()}
        disabled={run.isPending}
        title="Ask the provider what this credential is and what it can do"
      >
        {run.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <ShieldCheck className="h-3 w-3" />}
        Test
      </Button>
    </>
  ) : null;

  const details =
    open && (result || run.isError) ? (
      <CheckDetails result={result} error={run.isError ? (run.error as Error).message : null} />
    ) : null;

  return { controls, details };
}

export function CheckDetails({ result, error }: { result: CredentialCheck | null; error: string | null }) {
  if (error) return <p className="mt-2 text-xs text-destructive">{error}</p>;
  if (!result) return null;
  return (
    <div className="mt-2 space-y-1.5 border-t border-border/40 pt-2 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <span className={`h-2 w-2 rounded-full ${DOT[result.status]}`} />
        <span className="font-medium">
          {result.status === "ok" ? "Works" : result.status === "warn" ? "Works, with gaps" : "Doesn't work"}
        </span>
        {result.identity && (
          <span className="text-muted-foreground">
            as <span className="font-mono text-foreground">{result.identity}</span>
          </span>
        )}
        {result.expiresAt && (
          <span className="text-muted-foreground">
            · expires {formatDistanceToNow(new Date(result.expiresAt), { addSuffix: true })}
          </span>
        )}
      </div>
      {result.scopes && result.scopes.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {result.scopes.map((s) => (
            <Badge key={s} variant="secondary" className="font-mono text-[10px]">
              {s}
            </Badge>
          ))}
        </div>
      )}
      <ul className="space-y-0.5">
        {result.checks.map((c, i) => (
          <li key={i} className="flex items-start gap-1.5">
            {c.ok === true ? (
              <Check className="mt-0.5 h-3 w-3 shrink-0 text-emerald-400" />
            ) : c.ok === false ? (
              <X className="mt-0.5 h-3 w-3 shrink-0 text-destructive" />
            ) : (
              <Minus className="mt-0.5 h-3 w-3 shrink-0 text-muted-foreground" />
            )}
            <span>
              {c.label}
              {c.detail && <span className="text-muted-foreground"> — {c.detail}</span>}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Test a credential *where it is used* (spec 28 phase 4): a git token against
 * a project's repos, or against the image a host pulls. Shown next to the
 * picker that chose the credential.
 */
export function ContextCheck({
  credentialId,
  projectId,
  image,
  label,
}: {
  credentialId: string | null;
  projectId?: string;
  image?: string;
  label: string;
}) {
  const run = useMutation({
    mutationFn: () => checkCredential(credentialId!, { projectId, image }),
  });
  if (!credentialId) return null;
  return (
    <div>
      <Button
        type="button"
        size="sm"
        variant="ghost"
        className="h-7 px-2 text-xs"
        onClick={() => run.mutate()}
        disabled={run.isPending}
      >
        {run.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <ShieldCheck className="h-3 w-3" />}
        {label}
      </Button>
      {(run.data || run.isError) && (
        <CheckDetails result={run.data ?? null} error={run.isError ? (run.error as Error).message : null} />
      )}
    </div>
  );
}
