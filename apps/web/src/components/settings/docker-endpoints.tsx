"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { formatDistanceToNow } from "date-fns";
import { Container, Loader2, RefreshCw, Trash2 } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
  deleteDockerEndpoint,
  getDockerEndpoints,
  type DockerEndpoint,
} from "@/services/docker-endpoints";

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
            None yet — sandboxes run on this machine&apos;s Docker.
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
              placeholder="ssh://user@host"
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
          <p className="text-[11px] text-muted-foreground">
            Only <code>ssh://</code> — the browser session is forwarded through
            the same connection. Key auth only; accept the host key once from a
            terminal first.
          </p>
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
    </div>
  );
}
