"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { formatDistanceToNow } from "date-fns";
import { Check, Container, Copy, FlaskConical, KeyRound, Loader2, RefreshCw, Trash2 } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CheckDetails } from "@/components/settings/credential-check";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NO_AUTOFILL } from "@/lib/utils";
import {
  addDockerEndpoint,
  checkDockerEndpoint,
  checkEndpointForSandboxes,
  deleteDockerEndpoint,
  getDockerEndpoints,
  getHostEndpointKey,
  type DockerEndpoint,
} from "@/services/docker-endpoints";
import { copyText } from "@/lib/clipboard";

const QUERY_KEY = ["docker-endpoints"];

function formatMem(mb: number): string {
  return mb >= 1024 ? `${Math.round(mb / 1024)} GB` : `${mb} MB`;
}

/**
 * Other machines' Docker daemons that local sandboxes can run on (spec 26).
 * Adding one probes it first, so a row here is a daemon that answered.
 */
export function DockerEndpointsSection() {
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [host, setHost] = useState("");

  const endpoints = useQuery({ queryKey: QUERY_KEY, queryFn: getDockerEndpoints });
  // On a Nexus host (spec 27 phase 6): it has no Docker of its own, and reaches
  // endpoints with a key of its own that the target has to authorize.
  const hostKey = useQuery({ queryKey: ["host-endpoint-key"], queryFn: getHostEndpointKey });
  const isHost = hostKey.data?.isHost ?? false;
  const invalidate = () => qc.invalidateQueries({ queryKey: QUERY_KEY });

  const add = useMutation({
    mutationFn: addDockerEndpoint,
    onSuccess: () => {
      setName("");
      setHost("");
      invalidate();
    },
  });
  const check = useMutation({ mutationFn: checkDockerEndpoint, onSettled: invalidate });
  const remove = useMutation({ mutationFn: deleteDockerEndpoint, onSettled: invalidate });

  const list = endpoints.data ?? [];

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Container className="h-5 w-5" />
          Docker endpoints
        </CardTitle>
        <CardDescription>
          Other machines on your network whose Docker can run local sandboxes —
          their CPU and memory, this dashboard. Reached over SSH with this
          machine&apos;s key; the SSH user must be in the <code>docker</code>{" "}
          group there, which is root on that machine.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {endpoints.isLoading ? (
          <div className="text-sm text-muted-foreground">Loading endpoints...</div>
        ) : list.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {isHost
              ? "None yet — this Nexus host has no Docker of its own, so local sandboxes need one: add the machine it runs on (or another)."
              : "None yet — sandboxes run on this machine\u2019s Docker."}
          </p>
        ) : (
          <div className="space-y-2">
            {list.map((ep) => (
              <EndpointRow
                key={ep.id}
                endpoint={ep}
                checking={check.isPending && check.variables === ep.id}
                removing={remove.isPending && remove.variables === ep.id}
                onCheck={() => check.mutate(ep.id)}
                onRemove={() => remove.mutate(ep.id)}
              />
            ))}
          </div>
        )}
        {remove.isError && (
          <p className="text-xs text-destructive">{(remove.error as Error).message}</p>
        )}

        {isHost && hostKey.data?.publicKey && <HostKeyCard publicKey={hostKey.data.publicKey} />}

        <form
          className="space-y-2 rounded-md border border-border/50 p-3"
          onSubmit={(e) => {
            e.preventDefault();
            add.mutate({ name: name.trim(), host: host.trim() });
          }}
        >
          <Label className="text-xs font-medium">Add endpoint</Label>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Input
              {...NO_AUTOFILL}
              placeholder="workstation"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="sm:w-40"
              aria-label="Name"
            />
            <Input
              {...NO_AUTOFILL}
              placeholder={isHost ? "ssh://user@192.168.1.35" : "ssh://user@host"}
              value={host}
              onChange={(e) => setHost(e.target.value)}
              className="font-mono text-xs"
              aria-label="SSH host"
            />
            <Button type="submit" disabled={add.isPending || !name.trim() || !host.trim()}>
              {add.isPending ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  Probing…
                </>
              ) : (
                "Add"
              )}
            </Button>
          </div>
          {add.isError && (
            <pre className="whitespace-pre-wrap text-xs text-destructive">
              {(add.error as Error).message}
            </pre>
          )}
          {isHost ? (
            <p className="text-[11px] text-muted-foreground">
              Use an address <strong>this host</strong> can reach — the machine&apos;s LAN IP or DNS name, not
              an alias from your laptop&apos;s <code>~/.ssh/config</code> (it doesn&apos;t exist here), and not a
              Tailscale address (unreachable from inside the host). Its host key is recorded on the first
              connection.
            </p>
          ) : (
            <p className="text-[11px] text-muted-foreground">
              Only <code>ssh://</code> — the browser session is forwarded through
              the same connection. Key auth only; accept the host key once from a
              terminal first.
            </p>
          )}
        </form>
      </CardContent>
    </Card>
  );
}

function EndpointRow({
  endpoint: ep,
  checking,
  removing,
  onCheck,
  onRemove,
}: {
  endpoint: DockerEndpoint;
  checking: boolean;
  removing: boolean;
  onCheck: () => void;
  onRemove: () => void;
}) {
  const healthy = !ep.lastError;
  const qc = useQueryClient();
  const [showCheck, setShowCheck] = useState(false);
  const sandboxTest = useMutation({
    mutationFn: () => checkEndpointForSandboxes(ep.id),
    onSettled: () => {
      setShowCheck(true);
      void qc.invalidateQueries({ queryKey: QUERY_KEY });
    },
  });
  const check = sandboxTest.data ?? ep.sandboxCheck ?? null;
  const dot = check ? { ok: "bg-emerald-400", warn: "bg-amber-400", fail: "bg-destructive" }[check.status] : null;
  return (
    <div className="rounded-md border border-border/50 bg-muted/20 px-3 py-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span
          className={`h-1.5 w-1.5 shrink-0 rounded-full ${healthy ? "bg-emerald-400" : "bg-destructive"}`}
          title={healthy ? "Answered the last check" : "The last check failed"}
        />
        <span className="text-sm font-medium">{ep.name}</span>
        <code className="text-[11px] text-muted-foreground">{ep.host}</code>
        {ep.serverVersion && (
          <Badge variant="secondary" className="text-[10px]">
            Docker {ep.serverVersion}
          </Badge>
        )}
        {ep.arch && (
          <Badge variant="secondary" className="text-[10px]">
            {ep.arch}
          </Badge>
        )}
        {ep.memTotalMb != null && (
          <Badge variant="secondary" className="text-[10px]">
            {formatMem(ep.memTotalMb)} RAM
          </Badge>
        )}
        {ep.sandboxCount > 0 && (
          <Badge variant="outline" className="text-[10px]">
            {ep.sandboxCount} sandbox{ep.sandboxCount === 1 ? "" : "es"}
          </Badge>
        )}
        {ep.hostCount > 0 && (
          <Badge variant="outline" className="text-[10px]">
            {ep.hostCount} Nexus host{ep.hostCount === 1 ? "" : "s"}
          </Badge>
        )}
        <div className="ml-auto flex items-center gap-1">
          {ep.lastCheckedAt && (
            <span className="text-[10px] text-muted-foreground">
              checked {formatDistanceToNow(new Date(ep.lastCheckedAt), { addSuffix: true })}
            </span>
          )}
          {dot && (
            <button
              type="button"
              onClick={() => setShowCheck((v) => !v)}
              title={`Sandbox readiness: ${check!.status}`}
              className="flex items-center"
            >
              <span className={`h-2 w-2 rounded-full ${dot}`} />
            </button>
          )}
          <Button
            size="sm"
            variant="ghost"
            className="h-6 px-2 text-xs"
            onClick={() => sandboxTest.mutate()}
            disabled={sandboxTest.isPending}
            title="Run throwaway containers there: could a sandbox work on this machine?"
          >
            {sandboxTest.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <FlaskConical className="h-3 w-3" />}
            {sandboxTest.isPending ? "Testing…" : "Test for sandboxes"}
          </Button>
          <Button
            size="icon-sm"
            variant="ghost"
            title="Check again"
            onClick={onCheck}
            disabled={checking}
          >
            <RefreshCw className={`h-3.5 w-3.5 ${checking ? "animate-spin" : ""}`} />
          </Button>
          <Button
            size="icon-sm"
            variant="ghost"
            title={
              ep.sandboxCount + ep.hostCount > 0
                ? "Destroy what runs on it first"
                : "Remove endpoint"
            }
            onClick={onRemove}
            disabled={removing || ep.sandboxCount + ep.hostCount > 0}
          >
            <Trash2 className="h-3.5 w-3.5 text-destructive" />
          </Button>
        </div>
      </div>
      {ep.lastError && (
        <pre className="mt-1.5 whitespace-pre-wrap text-[11px] text-destructive">
          {ep.lastError}
        </pre>
      )}
      {showCheck && (check || sandboxTest.isError) && (
        <CheckDetails
          result={check}
          error={sandboxTest.isError ? (sandboxTest.error as Error).message : null}
        />
      )}
    </div>
  );
}

/**
 * The key a Nexus host reaches endpoints with, and the one line that
 * authorizes it on a target. The private half stays in the host's data volume.
 */
function HostKeyCard({ publicKey }: { publicKey: string }) {
  const [copied, setCopied] = useState<"key" | "cmd" | null>(null);
  const command = `echo '${publicKey}' >> ~/.ssh/authorized_keys`;
  const copy = async (what: "key" | "cmd") => {
    await copyText(what === "key" ? publicKey : command);
    setCopied(what);
    setTimeout(() => setCopied(null), 1500);
  };
  return (
    <div className="space-y-2 rounded-md border border-border/50 p-3">
      <Label className="flex items-center gap-1.5 text-xs font-medium">
        <KeyRound className="h-3.5 w-3.5" /> This host&apos;s SSH key
      </Label>
      <div className="flex items-center gap-2">
        <code className="min-w-0 flex-1 truncate rounded bg-muted px-2 py-1 font-mono text-[11px]" title={publicKey}>
          {publicKey}
        </code>
        <Button type="button" size="sm" variant="outline" className="h-7 gap-1 px-2 text-xs" onClick={() => void copy("key")}>
          {copied === "key" ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />} Copy
        </Button>
      </div>
      <p className="text-[11px] text-muted-foreground">
        On the target machine, as the user you will connect as, run once:
      </p>
      <div className="flex items-center gap-2">
        <code className="min-w-0 flex-1 truncate rounded bg-muted px-2 py-1 font-mono text-[11px]" title={command}>
          {command}
        </code>
        <Button type="button" size="sm" variant="outline" className="h-7 gap-1 px-2 text-xs" onClick={() => void copy("cmd")}>
          {copied === "cmd" ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />} Copy
        </Button>
      </div>
      <p className="text-[11px] text-muted-foreground">
        That user must be in the <code>docker</code> group there — root-equivalent on that machine, like your
        laptop&apos;s access. On a shared machine, use a dedicated user.
      </p>
    </div>
  );
}
