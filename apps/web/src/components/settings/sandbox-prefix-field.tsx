"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export type PrefixResponse = {
  prefix: string;
  storedPrefix: string | null;
  defaultPrefix: string;
  maxLength: number;
  /** A generated name as it would really come out, for the project asked about. */
  sample: string;
};

/**
 * The prefix control, shared by Settings → Cloud and the per-project launch
 * step. One component because it edits one setting: a user who changes it from
 * the sandbox wizard must see the same value, and the same warning, as one who
 * changes it from Settings.
 */
export function SandboxPrefixField({
  projectId,
  disabled = false,
  /** Rendered under the field — where the caller explains the blast radius. */
  note,
}: {
  projectId?: string;
  disabled?: boolean;
  note?: React.ReactNode;
}) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<string | null>(null);

  const query = projectId
    ? `/api/settings/sandbox-prefix?projectId=${encodeURIComponent(projectId)}`
    : "/api/settings/sandbox-prefix";

  const info = useQuery({
    queryKey: ["sandbox-prefix", projectId ?? null],
    queryFn: async (): Promise<PrefixResponse> => {
      const res = await fetch(query, { cache: "no-store" });
      if (!res.ok) throw new Error("Could not read the sandbox prefix");
      return res.json();
    },
  });

  const save = useMutation({
    mutationFn: async (prefix: string) => {
      const res = await fetch("/api/settings/sandbox-prefix", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prefix, projectId }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(
          typeof body.error === "string" ? body.error : "Could not save the prefix",
        );
      }
      return res.json() as Promise<PrefixResponse>;
    },
    onSuccess: (data) => {
      setDraft(data.storedPrefix ?? "");
      // Key prefix, not exact key: the same setting is on screen in Settings
      // and in every open launch step, and they must not disagree.
      queryClient.invalidateQueries({ queryKey: ["sandbox-prefix"] });
    },
  });

  // `draft === null` means "not edited yet", so the field reads from the query
  // until the user types — no effect needed to seed it, and a refetch cannot
  // overwrite something half-typed.
  const stored = info.data?.storedPrefix ?? "";
  const value = draft ?? stored;
  const dirty = value !== stored;
  const busy = disabled || save.isPending;

  if (info.isLoading) {
    return (
      <p className="flex items-center gap-2 text-xs text-muted-foreground">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        Loading the prefix…
      </p>
    );
  }

  if (info.isError || !info.data) {
    return (
      <p className="text-xs text-destructive">
        Could not read the current prefix.
      </p>
    );
  }

  return (
    <div className="space-y-1.5">
      <Label className="text-sm">Prefix</Label>
      <div className="flex gap-2">
        <Input
          className="h-9 max-w-xs text-sm font-mono"
          value={value}
          maxLength={info.data.maxLength}
          placeholder={info.data.defaultPrefix}
          onChange={(e) => setDraft(e.target.value)}
          disabled={busy}
        />
        <Button
          // Defaults to "submit"; this renders next to real forms.
          type="button"
          size="sm"
          variant="outline"
          className="h-9"
          disabled={!dirty || busy}
          onClick={() => save.mutate(value)}
        >
          {save.isPending && <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />}
          Save prefix
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        {dirty ? (
          <>Save to apply — auto-named sandboxes become <code>{value}…</code></>
        ) : (
          <>
            Auto-named sandboxes come out as <code>{info.data.sample}</code>. The
            trailing <code>-</code> is added for you; leave empty for{" "}
            <code>{info.data.defaultPrefix}</code>.
          </>
        )}
      </p>
      {save.isError && (
        <p className="text-xs text-destructive">
          {(save.error as Error).message}
        </p>
      )}
      {note}
    </div>
  );
}
