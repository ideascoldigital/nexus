"use client";

import { copyText } from "@/lib/clipboard";

/**
 * SSH access to a Nexus host. Spec: `specs/19-nexus-host-provisioning.md`.
 *
 * A host is a VM the user owns but has no way into from the dashboard —
 * provisioning already registers Nexus's keypair on it, so the access exists
 * and only needs surfacing. Three ways out, in the order people reach for
 * them: a terminal in the app, VS Code over Remote-SSH, and the raw `ssh`
 * command for anything else.
 */

import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Check, Copy, Loader2, SquareTerminal } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { RealTerminal } from "@/components/terminal/real-terminal";
import { useToast } from "@/hooks/use-toast";
import {
  getHostSsh,
  openHostInVsCode,
  type HostSshTarget,
  type NexusHostSummary,
} from "@/services/hosts";

/**
 * A terminal on the host, in a dialog.
 *
 * `RealTerminal` opens its websocket on mount and keeps it for the life of the
 * component, so the dialog mounts it only while open — closing the dialog ends
 * the session rather than leaving an ssh process attached to a hidden pane.
 */
function HostTerminalDialog({
  host,
  target,
  open,
  onOpenChange,
}: {
  host: NexusHostSummary;
  target: HostSshTarget;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle>{host.name}</DialogTitle>
          <DialogDescription className="font-mono text-xs">
            {target.user}@{target.host}
            {target.overTailnet ? " · over Tailscale" : ""}
          </DialogDescription>
        </DialogHeader>
        {/* Fixed height: xterm's fit addon measures its container, and a
            grid-auto row would collapse to nothing before the first fit. */}
        <div className="h-[28rem] overflow-hidden rounded-md border">
          {open && <RealTerminal workingDirectory={target.terminalTarget} />}
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function HostSshAccess({ host }: { host: NexusHostSummary }) {
  const { toast } = useToast();
  // Stamped with the host state it was resolved against: the tailnet address
  // only appears once the bootstrap finishes, so a target resolved before then
  // points at the public IP and must not be reused afterwards.
  const [resolved, setResolved] = useState<{
    stamp: string;
    target: HostSshTarget;
  } | null>(null);
  const [terminalOpen, setTerminalOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  const stamp = `${host.status}:${host.tailscaleIp ?? ""}:${host.publicIp ?? ""}`;
  const target = resolved?.stamp === stamp ? resolved.target : null;

  /** Resolve (and register) the SSH target, reusing it once resolved. */
  const resolve = useMutation({
    mutationFn: async () => target ?? (await getHostSsh(host.id)),
    onSuccess: (t) => setResolved({ stamp, target: t }),
    onError: (err: Error) =>
      toast({
        title: "Could not set up SSH access",
        description: err.message,
        variant: "destructive",
      }),
  });

  const vscode = useMutation({
    mutationFn: () => openHostInVsCode(host.id),
    onSuccess: (res) => {
      // The server launches VS Code itself; the uri is the fallback for when it
      // has no `code` CLI and no OS opener (a headless host serving the UI).
      if (!res.launched) window.location.href = res.uri;
    },
    onError: (err: Error) =>
      toast({
        title: "Could not open VS Code",
        description: err.message,
        variant: "destructive",
      }),
  });

  const openTerminal = async () => {
    const t = await resolve.mutateAsync().catch(() => null);
    if (t) setTerminalOpen(true);
  };

  const copyCommand = async () => {
    const t = await resolve.mutateAsync().catch(() => null);
    if (!t) return;
    await copyText(t.command);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
    toast({
      title: "SSH command copied",
      description: `\`ssh ${t.alias}\` also works — the host is in your SSH config now.`,
    });
  };

  const busy = resolve.isPending || vscode.isPending;
  // Remote-SSH needs the host to have finished bootstrapping — /opt/nexus-host
  // is only fully there once it has. A half-provisioned host still gets the
  // terminal, which is the thing worth having when it failed.
  const canOpenVsCode = host.status === "running";

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={() => void openTerminal()}
          disabled={busy}
        >
          {resolve.isPending ? (
            <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />
          ) : (
            <SquareTerminal className="h-4 w-4 mr-1.5" />
          )}
          Terminal
        </Button>
        {canOpenVsCode && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => vscode.mutate()}
            disabled={busy}
          >
            {vscode.isPending && (
              <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />
            )}
            Open in VS Code
          </Button>
        )}
        <Button
          variant="ghost"
          size="sm"
          onClick={() => void copyCommand()}
          disabled={busy}
        >
          {copied ? (
            <Check className="h-4 w-4 mr-1.5 text-emerald-600" />
          ) : (
            <Copy className="h-4 w-4 mr-1.5" />
          )}
          Copy ssh command
        </Button>
      </div>

      {target && (
        <p className="text-xs text-muted-foreground font-mono break-all">
          {target.command}
        </p>
      )}

      {target && (
        <HostTerminalDialog
          host={host}
          target={target}
          open={terminalOpen}
          onOpenChange={setTerminalOpen}
        />
      )}
    </div>
  );
}
