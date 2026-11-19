"use client";

/**
 * Getting into a Nexus host that runs on a Docker endpoint (spec 27).
 *
 * Such a host has no sshd of its own — it is containers on someone else's
 * machine — so where a VM host offers SSH, this offers the two doors that do
 * exist: a terminal in the app's container, reached through the endpoint's
 * Docker, and the equivalent `docker -H … exec` to paste anywhere.
 */

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Check, Copy, SquareTerminal } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { RealTerminal } from "@/components/terminal/real-terminal";
import { copyText } from "@/lib/clipboard";
import { useToast } from "@/hooks/use-toast";
import { getDockerEndpoints } from "@/services/docker-endpoints";
import type { NexusHostSummary } from "@/services/hosts";

export function EndpointHostAccess({ host }: { host: NexusHostSummary }) {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const { data: endpoints = [] } = useQuery({
    queryKey: ["docker-endpoints"],
    queryFn: getDockerEndpoints,
  });
  const endpoint = endpoints.find((e) => e.id === host.dockerEndpointId);
  // The project is the row's instanceId; compose names the app container.
  const container = host.instanceId ? `${host.instanceId}-nexux-1` : null;
  if (!container || !host.dockerEndpointId) return null;

  // The terminal server resolves the id to a host itself; the browser never
  // sends one (spec 26).
  const target = `docker-host://${host.dockerEndpointId}@${container}`;
  const command = endpoint ? `docker -H ${endpoint.host} exec -it ${container} bash` : null;

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        <SquareTerminal className="h-4 w-4 mr-1.5" />
        Terminal
      </Button>
      {command && (
        <Button
          variant="ghost"
          size="sm"
          onClick={async () => {
            await copyText(command);
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
            toast({ title: "Command copied", description: command });
          }}
          title={command}
        >
          {copied ? <Check className="h-4 w-4 mr-1.5" /> : <Copy className="h-4 w-4 mr-1.5" />}
          Copy docker exec
        </Button>
      )}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-4xl">
          <DialogHeader>
            <DialogTitle>{host.name}</DialogTitle>
            <DialogDescription className="font-mono text-xs">
              {container}
              {endpoint ? ` · on ${endpoint.name}` : ""}
            </DialogDescription>
          </DialogHeader>
          {/* Fixed height: xterm's fit addon measures its container. Mounted
              only while open, so closing ends the session. */}
          <div className="h-[28rem] overflow-hidden rounded-md border">
            {open && <RealTerminal workingDirectory={target} />}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
