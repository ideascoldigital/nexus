"use client";

// Save as seed (spec 29 phase 4): dump a database from this sandbox and make
// it the project's seed for that service.

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
import { useToast } from "@/hooks/use-toast";
import { getSandboxDatabases, saveSandboxDataAsSeed } from "@/services/seeds";

function formatBytes(n: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 10 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

const ENGINE = { postgres: "PostgreSQL", mysql: "MySQL/MariaDB", mongo: "MongoDB" } as const;

export function SandboxSeedSaveDialog({
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
  const [picked, setPicked] = useState<string | null>(null);
  const dbs = useQuery({
    queryKey: ["sandbox-databases", sandboxId],
    queryFn: () => getSandboxDatabases(projectId, sandboxId),
    enabled: open,
  });
  const list = dbs.data ?? [];
  const selected = list.find((d) => d.service === picked) ?? list[0] ?? null;

  const save = useMutation({
    mutationFn: () => saveSandboxDataAsSeed(projectId, sandboxId, selected!.service),
    onSuccess: ({ seed, previous }) => {
      onOpenChange(false);
      qc.invalidateQueries({ queryKey: ["project-seeds", projectId] });
      qc.invalidateQueries({ queryKey: ["sandbox-databases", sandboxId] });
      toast({
        title: `Saved as the seed for ${selected!.service}`,
        description: `${seed.fileName} (${formatBytes(seed.sizeBytes)})${
          previous ? ` replaces ${previous.fileName} (${formatBytes(previous.sizeBytes)})` : ""
        }. New sandboxes start from it.`,
      });
    },
    onError: (err: Error) => toast({ title: "Could not save the data", description: err.message, variant: "destructive" }),
  });

  return (
    <AlertDialog open={open} onOpenChange={(o) => !save.isPending && onOpenChange(o)}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center gap-2">
            <Database className="h-4 w-4" /> Save {sandboxName}&apos;s data as the seed?
          </AlertDialogTitle>
          <AlertDialogDescription>
            The database is dumped as it is now and becomes the project&apos;s seed for that service — every new
            sandbox, and every Reset data, starts from it.
          </AlertDialogDescription>
        </AlertDialogHeader>
        {dbs.isLoading ? (
          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
        ) : list.length === 0 ? (
          <p className="text-sm text-muted-foreground">This sandbox runs no PostgreSQL, MySQL/MariaDB or MongoDB service.</p>
        ) : (
          <div className="space-y-1.5">
            {list.map((d) => (
              <button
                key={d.service}
                type="button"
                disabled={save.isPending}
                onClick={() => setPicked(d.service)}
                className={`w-full rounded border px-2.5 py-1.5 text-left text-sm transition-colors ${
                  selected?.service === d.service ? "border-primary/60 bg-primary/10" : "hover:border-border"
                }`}
              >
                <span className="font-medium">{d.service}</span>{" "}
                <span className="text-xs text-muted-foreground">{ENGINE[d.engine]}</span>
                <span className="block text-xs text-muted-foreground">
                  {d.seed
                    ? `Replaces ${d.seed.fileName} (${formatBytes(d.seed.sizeBytes)})`
                    : "No seed yet — this becomes the first"}
                </span>
              </button>
            ))}
          </div>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={save.isPending}>Cancel</AlertDialogCancel>
          <Button disabled={save.isPending || !selected} onClick={() => save.mutate()}>
            {save.isPending ? (
              <>
                <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> Dumping…
              </>
            ) : selected?.seed ? (
              "Replace the seed"
            ) : (
              "Save as seed"
            )}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
