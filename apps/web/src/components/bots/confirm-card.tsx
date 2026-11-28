"use client";

// A project chat's "this costs money — go ahead?" (spec 39). The tap is an API
// call that approves exactly that action; the chat then hears "Confirmed".

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";

export function ConfirmCard({
  botId,
  actionId,
  title,
  detail,
  disabled,
}: {
  botId: string;
  actionId: string;
  title: string;
  detail: string;
  disabled: boolean;
}) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [busy, setBusy] = useState<"approve" | "cancel" | null>(null);
  const decide = async (decision: "approve" | "cancel") => {
    setBusy(decision);
    try {
      const res = await fetch(`/api/bots/${botId}/confirm/${actionId}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decision }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? "Could not send the answer");
      qc.invalidateQueries({ queryKey: ["bot-feed", botId] });
      qc.invalidateQueries({ queryKey: ["bots"] });
    } catch (err) {
      toast({ title: "Not sent", description: err instanceof Error ? err.message : undefined, variant: "destructive" });
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className="max-w-[560px] rounded-2xl border border-amber-500/30 bg-amber-500/5 px-4 py-3.5">
      <p className="flex items-center gap-2 text-[13.5px] font-semibold">
        <AlertTriangle className="h-4 w-4 text-amber-400" />
        {title}
      </p>
      {detail && <p className="pt-1 text-[12.5px] text-muted-foreground">{detail}</p>}
      <div className="flex gap-2 pt-3">
        <Button size="sm" className="rounded-full" disabled={disabled || busy !== null} onClick={() => decide("approve")}>
          {busy === "approve" && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          Confirm
        </Button>
        <Button size="sm" variant="secondary" className="rounded-full" disabled={disabled || busy !== null} onClick={() => decide("cancel")}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
