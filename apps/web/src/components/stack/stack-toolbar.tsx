"use client";

import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import {
  AlertTriangle,
  Loader2,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import {
  generateComposeFile,
  stackDown,
  stackPrepare,
  stackUp,
} from "@/services/stack";
import type { ComposeResult, StackStatus } from "@/lib/stack/types";

type Props = {
  projectId: string;
  dirty: boolean;
  saving: boolean;
  onSave: () => Promise<unknown>;
  status: StackStatus | undefined;
  onStatusChanged: () => void;
  assistantOpen: boolean;
  onToggleAssistant: () => void;
};

export function StackToolbar({
  projectId,
  dirty,
  saving,
  onSave,
  status,
  onStatusChanged,
  assistantOpen,
  onToggleAssistant,
}: Props) {
  const { toast } = useToast();
  const [preview, setPreview] = useState<ComposeResult | null>(null);

  const running = status?.running ?? false;

  const previewMutation = useMutation({
    mutationFn: async () => {
      if (dirty) await onSave();
      return generateComposeFile(projectId, { dryRun: true });
    },
    onSuccess: setPreview,
    onError: (err: Error) =>
      toast({
        title: "Compose generation failed",
        description: err.message,
        variant: "destructive",
      }),
  });

  const upMutation = useMutation({
    mutationFn: async () => {
      if (dirty) await onSave();
      return stackUp(projectId);
    },
    onSuccess: (res) => {
      toast({
        title: "Stack starting",
        description: res.warnings?.length ? res.warnings.join("\n") : undefined,
      });
      onStatusChanged();
    },
    onError: (err: Error) =>
      toast({
        title: "Failed to start stack",
        description: err.message,
        variant: "destructive",
      }),
  });

  // Install/build are their own action: they can take minutes, so folding them
  // into Up would make starting an already-prepared stack needlessly slow.
  const prepareMutation = useMutation({
    mutationFn: async () => {
      if (dirty) await onSave();
      return stackPrepare(projectId);
    },
    onSuccess: () =>
      toast({
        title: "Installing and building",
        description: "Progress is in the logs panel.",
      }),
    onError: (err: Error) =>
      toast({
        title: "Failed to prepare stack",
        description: err.message,
        variant: "destructive",
      }),
  });

  const downMutation = useMutation({
    mutationFn: () => stackDown(projectId),
    onSuccess: () => {
      toast({ title: "Stack stopped" });
      onStatusChanged();
    },
    onError: (err: Error) =>
      toast({
        title: "Failed to stop stack",
        description: err.message,
        variant: "destructive",
      }),
  });

  const runningCount =
    (status?.compose.filter((s) => s.state === "running").length ?? 0) +
    (status?.local.filter((l) => l.running).length ?? 0);
  const totalCount = (status?.compose.length ?? 0) + (status?.local.length ?? 0);

  return (
    <div className="flex items-center justify-between">
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <span>
          Drag repos & services onto the canvas. Connect app → dependency.
        </span>
        {running ? (
          <Badge className="text-xs bg-emerald-600 hover:bg-emerald-600">
            Running {runningCount}/{totalCount}
          </Badge>
        ) : null}
      </div>
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          variant={assistantOpen ? "default" : "outline"}
          onClick={onToggleAssistant}
        >
          Assistant
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() => previewMutation.mutate()}
          disabled={previewMutation.isPending}
        >
          {previewMutation.isPending && <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />}
          Preview compose
        </Button>
        <Button
          size="sm"
          variant="outline"
          title="Run the install and build phases on the canvas"
          onClick={() => prepareMutation.mutate()}
          disabled={prepareMutation.isPending}
        >
          {prepareMutation.isPending && (
            <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
          )}
          Prepare
        </Button>
        {running ? (
          <Button
            size="sm"
            variant="destructive"
            onClick={() => downMutation.mutate()}
            disabled={downMutation.isPending}
          >
            {downMutation.isPending && <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />}
            Down
          </Button>
        ) : (
          <Button
            size="sm"
            variant="outline"
            className="border-emerald-600 text-emerald-500 hover:bg-emerald-600/10"
            onClick={() => upMutation.mutate()}
            disabled={upMutation.isPending}
          >
            {upMutation.isPending && <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />}
            Up
          </Button>
        )}
        <Button size="sm" onClick={() => onSave()} disabled={!dirty || saving}>
          {saving && <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />}
          Save
        </Button>
      </div>

      <Dialog open={!!preview} onOpenChange={(o) => !o && setPreview(null)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle className="text-sm">
              Generated docker-compose.yml
            </DialogTitle>
          </DialogHeader>
          {preview?.warnings.length ? (
            <div className="space-y-1">
              {preview.warnings.map((w, i) => (
                <div
                  key={i}
                  className="flex items-start gap-1.5 text-xs text-amber-500"
                >
                  <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                  {w}
                </div>
              ))}
            </div>
          ) : null}
          <pre className="max-h-[50vh] overflow-auto rounded-md border bg-black/40 p-3 text-[13px] font-mono whitespace-pre">
            {preview?.yaml || "# (empty — no docker-mode nodes)"}
          </pre>
        </DialogContent>
      </Dialog>
    </div>
  );
}
