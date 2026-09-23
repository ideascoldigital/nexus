"use client";

import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import {
  AlertTriangle,
  CheckCircle2,
  Info,
  Loader2,
  ShieldCheck,
  XCircle,
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
  validateStack,
} from "@/services/stack";
import type {
  ComposeResult,
  StackStatus,
  StackValidation,
} from "@/lib/stack/types";

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
  const [validation, setValidation] = useState<StackValidation | null>(null);

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

  const validateMutation = useMutation({
    // Saving first, like every other action here: validating the canvas as
    // persisted rather than as drawn is the only way the answer describes what
    // a provision would actually read.
    mutationFn: async () => {
      if (dirty) await onSave();
      return validateStack(projectId);
    },
    onSuccess: setValidation,
    onError: (err: Error) =>
      toast({
        title: "Validation failed",
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
          title="Check the definition, and what the last sandbox recorded"
          onClick={() => validateMutation.mutate()}
          disabled={validateMutation.isPending}
        >
          {validateMutation.isPending ? (
            <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
          ) : (
            <ShieldCheck className="h-3.5 w-3.5 mr-1.5" />
          )}
          Validate
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

      <Dialog
        open={!!validation}
        onOpenChange={(o) => !o && setValidation(null)}
      >
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle className="text-sm flex items-center gap-2">
              {validation?.ok ? (
                <CheckCircle2 className="h-4 w-4 text-emerald-500" />
              ) : (
                <XCircle className="h-4 w-4 text-red-500" />
              )}
              {validation?.ok
                ? "The definition holds together"
                : "The definition has problems"}
            </DialogTitle>
          </DialogHeader>

          <div className="space-y-4 max-h-[60vh] overflow-auto">
            {validation?.findings.length ? (
              <div className="space-y-2">
                {validation.findings.map((f, i) => (
                  <div key={i} className="flex items-start gap-2 text-xs">
                    {f.severity === "error" ? (
                      <XCircle className="h-3.5 w-3.5 shrink-0 mt-0.5 text-red-500" />
                    ) : f.severity === "warning" ? (
                      <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5 text-amber-500" />
                    ) : (
                      <Info className="h-3.5 w-3.5 shrink-0 mt-0.5 text-muted-foreground" />
                    )}
                    <div className="space-y-0.5">
                      <div>{f.message}</div>
                      {f.fix ? (
                        <div className="text-muted-foreground">{f.fix}</div>
                      ) : null}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-xs text-muted-foreground">
                No problems found in the definition.
              </div>
            )}

            {/*
              The observed half, kept visibly apart. A definition passing its
              static checks is not evidence that anything booted — only a real
              provision is, and it may be absent or stale.
            */}
            <div className="rounded-md border p-3 space-y-2">
              <div className="text-xs font-medium">Last provisioned run</div>
              {!validation?.observed ? (
                <div className="text-xs text-muted-foreground">
                  This project has never been provisioned, so nothing has
                  proven it boots.
                </div>
              ) : validation.observed.unavailable ? (
                <div className="text-xs text-muted-foreground">
                  {validation.observed.unavailable}
                </div>
              ) : (
                <div className="space-y-2">
                  <div className="text-xs text-muted-foreground">
                    {validation.observed.sandboxName} ·{" "}
                    {new Date(
                      validation.observed.provisionedAt,
                    ).toLocaleString()}
                  </div>
                  <div className="flex items-center gap-1.5 text-xs">
                    {validation.observed.booted === true ? (
                      <>
                        <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />
                        Every app answered on its port.
                      </>
                    ) : validation.observed.booted === false ? (
                      <>
                        <XCircle className="h-3.5 w-3.5 text-red-500" />
                        An app did not answer on its port.
                      </>
                    ) : (
                      <>
                        <Info className="h-3.5 w-3.5 text-muted-foreground" />
                        No app declared a port, so nothing was probed.
                      </>
                    )}
                  </div>
                  {validation.observed.failed.length ? (
                    <div className="space-y-1.5">
                      {validation.observed.failed.map((step) => (
                        <div key={step.step} className="text-xs">
                          <div className="flex items-center gap-1.5">
                            <XCircle className="h-3.5 w-3.5 shrink-0 text-red-500" />
                            <span className="font-mono">{step.step}</span>
                            <span className="text-muted-foreground">
                              exit {step.exitCode}
                            </span>
                          </div>
                          {step.tail ? (
                            <pre className="mt-1 ml-5 max-h-32 overflow-auto rounded border bg-black/40 p-2 text-[11px] font-mono whitespace-pre-wrap">
                              {step.tail.trimEnd()}
                            </pre>
                          ) : null}
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="text-xs text-muted-foreground">
                      Every recorded step succeeded.
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        </DialogContent>
      </Dialog>

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
