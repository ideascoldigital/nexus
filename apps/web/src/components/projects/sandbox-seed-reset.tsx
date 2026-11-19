"use client";

// Reset data (spec 29 phase 3): put a running sandbox's databases back to the
// project's seeds, then re-run the repos' install step (migrations).

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Database, Loader2 } from "lucide-react";

import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/hooks/use-toast";
import { getSandboxSeeds, resetSandboxData } from "@/services/seeds";

export function SandboxSeedResetDialog({
  projectId,
  sandboxId,
  sandboxName,
  open,
  onOpenChange,
}: {
  projectId: string;
  sandboxId: string;
  sandboxName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [runSetup, setRunSetup] = useState(true);
  const seeds = useQuery({
    queryKey: ["sandbox-seeds", sandboxId],
    queryFn: () => getSandboxSeeds(projectId, sandboxId),
    enabled: open,
  });
  const reset = useMutation({
    mutationFn: () => resetSandboxData(projectId, sandboxId, { runSetup }),
    onSuccess: (res) => {
      onOpenChange(false);
      qc.invalidateQueries({ queryKey: ["sandbox-health", sandboxId] });
      const failed = res.services.filter((s) => !s.ok);
      toast(
        res.ok
          ? { title: "Data reset", description: res.services.map((s) => `${s.service}: ${s.message}`).join(" · ") }
          : {
              title: failed.length ? `Reset failed for ${failed.map((s) => s.service).join(", ")}` : "Data reset, but setup is still failing",
              description: failed.length
                ? failed.map((s) => s.message).join(" · ")
                : `Setup failed for ${res.setup?.failed.join(", ")} — open the bootstrap log for the reason.`,
              variant: "destructive",
            },
      );
    },
    onError: (err: Error) => toast({ title: "Could not reset the data", description: err.message, variant: "destructive" }),
  });

  const list = seeds.data ?? [];
  return (
    <AlertDialog open={open} onOpenChange={(o) => !reset.isPending && onOpenChange(o)}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center gap-2">
            <Database className="h-4 w-4" /> Reset data in {sandboxName}?
          </AlertDialogTitle>
          <AlertDialogDescription>
            Each database below is emptied and restored from the project&apos;s seed. Anything written to it in
            this sandbox is lost; the code and the rest of the sandbox are untouched.
          </AlertDialogDescription>
        </AlertDialogHeader>
        {seeds.isLoading ? (
          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
        ) : list.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            None of this sandbox&apos;s services has seed data. Attach a backup to a database service on the Stack
            canvas.
          </p>
        ) : (
          <div className="space-y-3">
            <ul className="space-y-1 text-sm">
              {list.map((s) => (
                <li key={s.service} className="flex items-center justify-between gap-2 rounded border px-2.5 py-1.5">
                  <span className="font-medium">{s.service}</span>
                  <span className="truncate font-mono text-xs text-muted-foreground">{s.fileName}</span>
                </li>
              ))}
            </ul>
            <label className="flex items-center justify-between gap-3 text-sm">
              <span>
                Re-run the repos&apos; install step afterwards
                <span className="block text-xs text-muted-foreground">
                  Where migrations run — so this branch&apos;s schema changes apply to the seed again.
                </span>
              </span>
              <Switch checked={runSetup} onCheckedChange={setRunSetup} disabled={reset.isPending} />
            </label>
          </div>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={reset.isPending}>Cancel</AlertDialogCancel>
          <Button
            variant="destructive"
            disabled={reset.isPending || list.length === 0}
            onClick={() => reset.mutate()}
          >
            {reset.isPending ? (
              <>
                <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
                {runSetup ? "Restoring and installing…" : "Restoring…"}
              </>
            ) : (
              "Reset data"
            )}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
