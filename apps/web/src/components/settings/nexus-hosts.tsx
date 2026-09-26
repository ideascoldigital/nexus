"use client";

import { copyText } from "@/lib/clipboard";

/**
 * Nexus hosts panel. Spec: `specs/19-nexus-host-provisioning.md`.
 *
 * Creating a host spends real money, so the form states the size it will
 * launch, the readiness checklist explains what is missing *before* the form is
 * filled in, and a host that failed to bootstrap keeps a prominent Destroy —
 * a half-provisioned VM is still billed.
 */

import { useEffect, useState } from "react";
import {
  useIsMutating,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  AlertTriangle,
  Check,
  Copy,
  Loader2,
  Plus,
  RefreshCw,
  Server,
  Trash2,
  X,
} from "lucide-react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/hooks/use-toast";
import {
  DEFAULT_REGISTRY_HOST,
  sandboxProviderLabel,
} from "@/components/settings/cloud-credentials";
import { HostSshAccess } from "@/components/settings/host-ssh-access";
import { EndpointHostAccess } from "@/components/settings/endpoint-host-access";
import {
  lastUpdateFailed,
  lastUpdateFinished,
} from "@/lib/self-update-log";
import {
  getCredentials,
  type CloudCredentialSummary,
} from "@/services/sandbox";
import { getDockerEndpoints, type DockerEndpoint } from "@/services/docker-endpoints";
import {
  HOST_IN_FLIGHT,
  HOST_REGIONS,
  HOST_SIZES,
  createHost,
  destroyHost,
  getHost,
  getHostReadiness,
  getHosts,
  getSelfUpdateLog,
  getVersion,
  selfUpdate,
  updateHost,
  type AppVersion,
  type HostStatus,
  type NexusHostSummary,
} from "@/services/hosts";

const STATUS_LABEL: Record<HostStatus, string> = {
  pending: "Queued",
  provisioning: "Creating the VM",
  bootstrapping: "Installing",
  running: "Running",
  error: "Failed",
  destroying: "Destroying",
  destroyed: "Destroyed",
};

/**
 * The registry an image reference points at. Mirrors `registryHost` in
 * `@nexux/sandbox`, which the bootstrap uses for `docker login` — duplicated
 * rather than imported because this file is a client component and that package
 * pulls in the whole provisioning stack.
 */
function registryHostOf(imageRef: string): string {
  const ref = imageRef.trim().toLowerCase();
  const slash = ref.indexOf("/");
  if (slash === -1) return ref ? "docker.io" : "";
  const first = ref.slice(0, slash);
  return first.includes(".") || first.includes(":") ? first : "docker.io";
}

/** Where a saved git credential can log in — its override, else its host's. */
function credentialRegistryHost(cred: CloudCredentialSummary): string {
  return (
    cred.registryHost?.trim().toLowerCase() ||
    DEFAULT_REGISTRY_HOST[cred.provider] ||
    ""
  );
}

function StatusPill({ status }: { status: HostStatus }) {
  const busy = HOST_IN_FLIGHT.includes(status);
  return (
    <Badge
      variant={
        status === "running"
          ? "secondary"
          : status === "error"
            ? "destructive"
            : "outline"
      }
      className="gap-1.5"
    >
      {busy && <Loader2 className="h-3 w-3 animate-spin" />}
      {STATUS_LABEL[status]}
    </Badge>
  );
}

export function NexusHostsSection() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [showForm, setShowForm] = useState(false);
  const [destroyTarget, setDestroyTarget] = useState<NexusHostSummary | null>(
    null,
  );

  const { data: readiness } = useQuery({
    queryKey: ["host-readiness"],
    queryFn: getHostReadiness,
  });
  // Machines you already have, which can hold a host instead of a VM (spec 27).
  const { data: endpoints = [] } = useQuery({
    queryKey: ["docker-endpoints"],
    queryFn: getDockerEndpoints,
  });

  // A destroy in flight counts as "something is moving" on its own. The row is
  // only marked `destroying` a couple of awaits into the request, so the
  // refetch fired alongside it can still read `running` — and `running` does
  // not poll, which would strand the panel on stale data until the whole
  // terraform run finished. Keyed off the mutation rather than the data, so it
  // cannot lose that race.
  const destroying = useIsMutating({ mutationKey: ["destroy-host"] }) > 0;

  const { data: hosts = [] } = useQuery({
    queryKey: ["hosts"],
    queryFn: getHosts,
    // Provisioning takes minutes; poll only while something is moving.
    refetchInterval: (query) =>
      destroying ||
      (query.state.data ?? []).some((h) => HOST_IN_FLIGHT.includes(h.status))
        ? 5000
        : false,
  });

  const destroy = useMutation({
    mutationKey: ["destroy-host"],
    mutationFn: destroyHost,
    // `DELETE` holds open for the whole terraform run — minutes. The row is
    // already `destroying` server-side long before it answers, so refetch as
    // soon as it is sent: that is what puts the card into its spinning state
    // and starts the poll. Waiting for `onSuccess` meant the panel sat on stale
    // `running` data for the entire destroy, and if the request was dropped
    // before it resolved nothing refreshed at all until a reload.
    onMutate: () => {
      queryClient.invalidateQueries({ queryKey: ["hosts"] });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["hosts"] });
      toast({ title: "Host destroyed" });
    },
    onError: (err: Error) => {
      // A failed destroy leaves the row at `error` with the reason on it —
      // worth showing, and the panel would otherwise keep rendering the
      // pre-destroy status.
      queryClient.invalidateQueries({ queryKey: ["hosts"] });
      toast({
        title: "Could not destroy the host",
        description: err.message,
        variant: "destructive",
      });
    },
  });

  // A host creating hosts is confusing and almost certainly unintended — but
  // updating *itself* is exactly what someone standing on the host wants.
  if (readiness?.isHost) {
    // A host on a Docker endpoint has nothing on its machine to ask for an
    // update (spec 27); say where updates come from instead of offering a
    // button that cannot work.
    return readiness.hostKind === "endpoint" ? <EndpointHostSelfCard /> : <SelfUpdateCard />;
  }

  // Two ways to get a machine: a cloud VM (terraform + a cloud credential),
  // or a Docker endpoint you already have (spec 27). Either is enough; the
  // tailnet key is required by both, because it is each host's only door.
  const blockers: string[] = [];
  const vmReady = Boolean(readiness?.terraformInstalled && readiness?.hasCloudCredential);
  const endpointReady = endpoints.length > 0;
  if (readiness && !vmReady && !endpointReady) {
    blockers.push(
      !readiness.terraformInstalled
        ? "no machine to put it on: terraform is not installed for a cloud VM, and no Docker endpoint is added (Settings → Cloud)"
        : "no machine to put it on: no Civo or AWS credential, and no Docker endpoint (Settings → Cloud)",
    );
  }
  if (readiness && !readiness.hasTailscaleCredential) {
    blockers.push("no Tailscale auth key saved (Settings → Cloud)");
  }
  const canCreate = blockers.length === 0;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Server className="h-5 w-5" />
          Nexus hosts
        </CardTitle>
        <CardDescription>
          A VM that runs Nexus 24/7, so schedules and Telegram keep working with
          your laptop closed. It joins your Tailscale network and is reachable
          only from there — the app has no login, so it must never be exposed to
          the internet.
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-6">
        {blockers.length > 0 && (
          <div className="space-y-1 rounded-lg border border-amber-500/40 bg-amber-500/5 p-4">
            <p className="text-sm font-medium">Before you can create a host:</p>
            <ul className="space-y-1">
              {blockers.map((b) => (
                <li
                  key={b}
                  className="text-sm text-muted-foreground flex gap-1.5"
                >
                  <X className="h-4 w-4 mt-0.5 shrink-0 text-amber-600" />
                  {b}
                </li>
              ))}
            </ul>
            <p className="text-sm text-muted-foreground pt-1">
              The Tailscale key must be <strong>ephemeral</strong>,{" "}
              <strong>pre-authorized</strong> and <strong>reusable</strong>, or
              the machine comes up unreachable.
            </p>
          </div>
        )}

        {hosts.length > 0 && (
          <div className="space-y-2">
            {hosts.map((host) => (
              <HostRow
                key={host.id}
                host={host}
                onDestroy={() => setDestroyTarget(host)}
                destroying={destroy.isPending}
              />
            ))}
          </div>
        )}

        {showForm ? (
          <CreateHostForm
            defaultImage={readiness?.defaultImage ?? ""}
            endpoints={endpoints}
            vmReady={vmReady}
            onDone={() => {
              setShowForm(false);
              queryClient.invalidateQueries({ queryKey: ["hosts"] });
            }}
            onCancel={() => setShowForm(false)}
          />
        ) : (
          <Button onClick={() => setShowForm(true)} disabled={!canCreate}>
            <Plus className="h-4 w-4 mr-1.5" />
            Create a host
          </Button>
        )}
      </CardContent>

      <AlertDialog
        open={destroyTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDestroyTarget(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Destroy “{destroyTarget?.name}”?
            </AlertDialogTitle>
            <AlertDialogDescription>
              {destroyTarget?.provider === "docker-endpoint" ? (
                <>
                  Its containers on {destroyTarget.region} <strong>and their volumes</strong>{" "}
                  — the database, credentials, checkouts and search indexes —
                  are deleted permanently, the same as destroying a VM host.
                  Export its configuration first if you want to keep it. This
                  cannot be undone.
                </>
              ) : (
                <>
                  The {destroyTarget?.size} instance and everything on it —
                  including the database and search indexes — are deleted
                  permanently. Export its configuration first if you want to
                  keep it. This cannot be undone.
                </>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (destroyTarget) destroy.mutate(destroyTarget.id);
                setDestroyTarget(null);
              }}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Destroy host
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}

/** One line naming a build, e.g. `v0.5.0 · a1b2c3d · built 2 Aug 2026`. */
function describeVersion(v: AppVersion): string {
  const parts = [`v${v.version}`];
  if (v.gitSha) parts.push(v.gitSha.slice(0, 7));
  if (v.builtAt) {
    const d = new Date(v.builtAt);
    if (!Number.isNaN(d.getTime())) parts.push(`built ${d.toLocaleDateString()}`);
  }
  return parts.join(" · ");
}

/** A comparable identity: any component changing means a different build. */
function buildKey(v: AppVersion | null | undefined): string {
  return v ? `${v.version}|${v.gitSha ?? ""}|${v.builtAt ?? ""}` : "";
}

/**
 * What Settings shows when the install *is* the host: no create form, and the
 * one action that belongs here — pulling a newer image of itself.
 *
 * The app restarts as part of the update, so the *request* can never report
 * success — it is the last thing this page sees before the process goes away.
 * Completion is detected instead by polling the updater's log for a
 * "finished" stamp newer than the one captured at click time, then comparing
 * the build identity (/api/version) from before and after: changed means
 * updated, unchanged means the pull found nothing newer.
 */
/** What Settings shows on a host that runs on someone's Docker endpoint. */
function EndpointHostSelfCard() {
  const { data: version } = useQuery({ queryKey: ["app-version"], queryFn: getVersion });
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Server className="h-5 w-5" />
          This Nexus host
        </CardTitle>
        <CardDescription>
          This install is a Nexus host running as containers on a Docker
          endpoint — a machine you already had. It can&apos;t update itself: it
          has no access to that machine&apos;s Docker, by design. Update it from
          the install that created it (Settings → Backup &amp; migration →
          Update); the database, credentials and search indexes live in volumes
          and survive the update.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <p className="text-sm text-muted-foreground">
          Running{" "}
          <span className="font-mono text-foreground">
            {version ? describeVersion(version) : "…"}
          </span>
        </p>
      </CardContent>
    </Card>
  );
}

function SelfUpdateCard() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [showLog, setShowLog] = useState(false);
  // Set while an accepted update runs; holds what "before" looked like so
  // completion registers as a change rather than as the stamp a past update
  // already left in the append-only log.
  const [pending, setPending] = useState<{
    finishedBefore: string | null;
    buildBefore: string;
    startedAt: number;
  } | null>(null);

  const { data: version } = useQuery({
    queryKey: ["app-version"],
    queryFn: getVersion,
  });

  const { data, dataUpdatedAt } = useQuery({
    queryKey: ["self-update-log"],
    queryFn: getSelfUpdateLog,
    // While an update runs the app drops out and comes back; keep knocking —
    // interval refetches carry on through the failed fetches in between.
    refetchInterval: pending ? 4000 : false,
  });

  useEffect(() => {
    if (!pending) return;
    const finished = lastUpdateFinished(data?.log ?? null);
    if (finished && finished !== pending.finishedBefore) {
      // Reacting to polled server state is exactly what this effect is for:
      // completion only ever arrives as new log content, never as an event.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setPending(null);
      if (lastUpdateFailed(data?.log ?? null)) {
        setShowLog(true);
        toast({
          title: "The update failed",
          description:
            "The updater could not pull the image — the log below says why. The host keeps running the old build.",
          variant: "destructive",
        });
        return;
      }
      // The pull ran; whether it replaced the app is what the build identity
      // answers. Fetched directly rather than via the cache, which still
      // holds the pre-update answer.
      void getVersion().then((v) => {
        queryClient.invalidateQueries({ queryKey: ["app-version"] });
        // The statusbar reads its own copy of the build identity and its
        // update badge, neither through this cache: a finished update that
        // left them alone showed the new version in this card and the old one
        // in the bar underneath it.
        window.dispatchEvent(new Event("nexux:build-changed"));
        if (buildKey(v) !== pending.buildBefore) {
          toast({
            title: "Update finished",
            description: v
              ? `Now running ${describeVersion(v)}.`
              : "The host restarted on the newly pulled image.",
          });
        } else {
          toast({
            title: "Already up to date",
            description:
              "The pull found no newer image, so nothing was restarted.",
          });
        }
      });
      return;
    }
    // The updater normally finishes in a couple of minutes; long past that,
    // stop claiming progress and point at the evidence instead.
    if (Date.now() - pending.startedAt > 15 * 60 * 1000) {
      setPending(null);
      setShowLog(true);
      toast({
        title: "No confirmation from the updater",
        description:
          "15 minutes passed without the updater reporting completion. The log below shows how far it got.",
        variant: "destructive",
      });
    }
  }, [pending, data, dataUpdatedAt, queryClient, toast]);

  const update = useMutation({
    mutationFn: selfUpdate,
    onSuccess: (res) => {
      toast({
        title: res.ok ? "Updating" : "Could not update",
        description: res.message,
        variant: res.ok ? undefined : "destructive",
      });
      if (res.ok) {
        setPending({
          finishedBefore: lastUpdateFinished(data?.log ?? null),
          buildBefore: buildKey(version),
          startedAt: Date.now(),
        });
      }
    },
    onError: (err: Error) =>
      toast({
        title: "Could not update",
        description: err.message,
        variant: "destructive",
      }),
  });

  const busy = update.isPending || pending !== null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Server className="h-5 w-5" />
          This Nexus host
        </CardTitle>
        <CardDescription>
          This install is itself a Nexus host, so it manages no others — create
          and destroy hosts from your local install. It can update itself:
          pulling the published image and restarting keeps the database,
          credentials and search indexes, which live in a volume.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">
          Running{" "}
          <span className="font-mono text-foreground">
            {version === undefined
              ? "…"
              : version === null
                ? "an unknown build"
                : describeVersion(version)}
          </span>
          {version === null &&
            " — this image predates version reporting; updating fixes that."}
        </p>

        <div className="flex items-center gap-2">
          <Button onClick={() => update.mutate()} disabled={busy}>
            {busy ? (
              <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />
            ) : (
              <RefreshCw className="h-4 w-4 mr-1.5" />
            )}
            {pending ? "Updating…" : "Update this host"}
          </Button>
          {data?.log && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setShowLog((v) => !v)}
            >
              {showLog ? "Hide" : "Show"} last update
            </Button>
          )}
        </div>

        <p className="text-sm text-muted-foreground">
          {pending
            ? "Updating — the page may drop out while the app restarts; the result is reported here when the updater finishes."
            : "Checking for a newer image and applying it are the same operation: if the pull finds nothing, this reports “already up to date” and restarts nothing."}
        </p>

        {showLog && data?.log && (
          <pre className="max-h-64 overflow-auto rounded bg-muted p-3 text-xs whitespace-pre-wrap">
            {data.log}
          </pre>
        )}
      </CardContent>
    </Card>
  );
}

function HostRow({
  host,
  onDestroy,
  destroying,
}: {
  host: NexusHostSummary;
  onDestroy: () => void;
  destroying: boolean;
}) {
  const { toast } = useToast();
  const [showLog, setShowLog] = useState(false);
  // Kept in state rather than refetched: the pull's output exists only in the
  // response to the request that caused it.
  const [updateLog, setUpdateLog] = useState<string | null>(null);
  const busy = HOST_IN_FLIGHT.includes(host.status);

  // Only fetched while the row is moving or the user opened the log — it is the
  // one field big enough to matter on a poll.
  const { data: detail } = useQuery({
    queryKey: ["host", host.id],
    queryFn: () => getHost(host.id),
    enabled: busy || showLog,
    refetchInterval: busy ? 5000 : false,
  });

  // Pull a newer image and restart the stack, over the SSH access provisioning
  // already set up. Unlike the host's own button this side has a shell, so it
  // reports what the pull actually did.
  const update = useMutation({
    mutationFn: () => updateHost(host.id),
    onSuccess: (res) => {
      setUpdateLog(res.log ?? null);
      toast({
        title: !res.ok
          ? "The update failed"
          : res.updated === false
            ? "Already up to date"
            : "Host updated",
        description: res.message,
        variant: res.ok ? undefined : "destructive",
      });
    },
    onError: (err: Error) =>
      toast({
        title: "Could not update the host",
        description: err.message,
        variant: "destructive",
      }),
  });

  const url = host.tailscaleIp ? `http://${host.tailscaleIp}:3030` : null;
  const onEndpoint = host.provider === "docker-endpoint";

  return (
    <div className="rounded-lg border p-4 space-y-3">
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-medium">{host.name}</span>
            <StatusPill status={host.status} />
          </div>
          <p className="text-sm text-muted-foreground">
            {host.provider} · {host.region} · {host.size}
          </p>
          {/* Which image the host runs — the tag Update pulls. Whether a newer
              build of it exists is what the Update button answers. */}
          <p
            className="text-xs font-mono text-muted-foreground truncate"
            title={host.imageRef}
          >
            {host.imageRef}
          </p>
          {url ? (
            <div className="flex items-center gap-2 pt-1">
              <a
                href={url}
                target="_blank"
                rel="noreferrer"
                className="text-sm font-mono text-primary hover:underline"
              >
                {url}
              </a>
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={() => {
                  void copyText(url);
                  toast({ title: "Address copied" });
                }}
              >
                <Copy className="h-3.5 w-3.5" />
              </Button>
            </div>
          ) : null}
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => update.mutate()}
            // Only a running host has a stack to pull into; anything else is
            // still being built or taken down.
            disabled={host.status !== "running" || update.isPending}
            title="Pull the published image and restart the stack"
          >
            {update.isPending ? (
              <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />
            ) : (
              <RefreshCw className="h-4 w-4 mr-1.5" />
            )}
            Update
          </Button>

          <Button
            variant="outline"
            size="sm"
            onClick={onDestroy}
            disabled={destroying || host.status === "destroying"}
          >
            <Trash2 className="h-4 w-4 mr-1.5" />
            Destroy
          </Button>
        </div>
      </div>

      {/* Only ever the last update's output, and only after one has run here —
          enough to see whether the pull found a newer image. */}
      {updateLog && (
        <pre className="max-h-48 overflow-auto rounded bg-muted p-3 text-xs whitespace-pre-wrap">
          {updateLog}
        </pre>
      )}

      {host.status === "running" && (
        <>
          <p className="text-sm text-muted-foreground flex gap-1.5">
            <Check className="h-4 w-4 mt-0.5 shrink-0 text-emerald-600" />
            Open Backup &amp; migration below to move your configuration onto it.
          </p>
          {onEndpoint ? <EndpointHostAccess host={host} /> : <HostSshAccess host={host} />}
        </>
      )}

      {/* A failed host is the case where access matters most — the bootstrap
          log in the UI is a tail, and the rest of the story is on the machine. */}
      {host.status === "error" &&
        (onEndpoint ? (
          <EndpointHostAccess host={host} />
        ) : (
          (host.publicIp || host.tailscaleIp) && <HostSshAccess host={host} />
        ))}

      {host.error && (
        <p className="text-sm text-destructive flex gap-1.5">
          <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
          {host.error}
        </p>
      )}

      {(busy || host.status === "error") && (
        <div className="space-y-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setShowLog((v) => !v)}
            className="h-7 px-2 text-xs"
          >
            {showLog ? "Hide" : "Show"} log
          </Button>
          {showLog && (
            <pre className="max-h-64 overflow-auto rounded bg-muted p-3 text-xs whitespace-pre-wrap">
              {detail?.log?.trim() || "Waiting for output…"}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Picks which saved credential provisions this host. Leaving it unset is
 * valid — the server falls back to the oldest credential of that provider —
 * so the field only matters once more than one key is saved.
 */
function CredentialField({
  id,
  label,
  credentials,
  value,
  onChange,
  empty,
  hint,
  optional = false,
  showProvider = false,
}: {
  id: string;
  label: string;
  credentials: CloudCredentialSummary[];
  value: string | null;
  onChange: (credentialId: string | null) => void;
  empty: string;
  hint?: string;
  /** Offers a "None" entry — for a credential that is not always needed. */
  optional?: boolean;
  /** Names the git host each token belongs to — GitHub and GitLab both fit. */
  showProvider?: boolean;
}) {
  // An id is opaque, so "no credential" needs a value of its own rather than
  // the empty string, which Base UI treats as nothing selected.
  const NONE = "__none__";

  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      {credentials.length === 0 ? (
        <p className="text-sm text-muted-foreground">{empty}</p>
      ) : (
        <Select
          value={value ?? (optional ? NONE : credentials[0].id)}
          onValueChange={(v) => v && onChange(v === NONE ? null : v)}
        >
          <SelectTrigger id={id}>
            {/* The value is an opaque id; Base UI renders it verbatim unless
                the label is looked up here. */}
            <SelectValue>
              {(v) => {
                const cred = credentials.find((c) => c.id === v);
                return (
                  <span className="truncate">
                    {v === NONE
                      ? "None"
                      : !cred
                        ? "Select…"
                        : showProvider
                          ? `${cred.name} · ${sandboxProviderLabel(cred.provider)}`
                          : cred.name}
                  </span>
                );
              }}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            {optional && <SelectItem value={NONE}>None</SelectItem>}
            {credentials.map((c) => (
              <SelectItem key={c.id} value={c.id}>
                {c.name}
                {showProvider ? ` · ${sandboxProviderLabel(c.provider)}` : ""}
                {c.hint ? ` · ${c.hint}` : ""}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
      {hint && <p className="text-sm text-muted-foreground">{hint}</p>}
    </div>
  );
}

function CreateHostForm({
  defaultImage,
  endpoints,
  vmReady,
  onDone,
  onCancel,
}: {
  defaultImage: string;
  endpoints: DockerEndpoint[];
  /** Terraform and a cloud credential are both there. */
  vmReady: boolean;
  onDone: () => void;
  onCancel: () => void;
}) {
  const { toast } = useToast();
  const [name, setName] = useState("nexus-host");
  // Start where the user can actually create one: a VM when that is set up,
  // otherwise their first endpoint.
  const [provider, setProvider] = useState<"civo" | "aws" | "docker-endpoint">(
    vmReady || endpoints.length === 0 ? "civo" : "docker-endpoint",
  );
  const [dockerEndpointId, setDockerEndpointId] = useState<string | null>(
    endpoints[0]?.id ?? null,
  );
  const onEndpoint = provider === "docker-endpoint";
  const endpoint = endpoints.find((e) => e.id === dockerEndpointId) ?? null;
  const [region, setRegion] = useState(HOST_REGIONS.civo[0]);
  const [size, setSize] = useState(HOST_SIZES.civo[2].value);
  const [imageRef, setImageRef] = useState(defaultImage);
  const [pullEmbeddingModel, setPullEmbeddingModel] = useState(true);
  // null = "let the server pick the oldest saved credential for the provider",
  // which is what creating a host did before this picker existed.
  const [credentialId, setCredentialId] = useState<string | null>(null);
  const [tailscaleCredentialId, setTailscaleCredentialId] = useState<
    string | null
  >(null);
  const [registryCredentialId, setRegistryCredentialId] = useState<
    string | null
  >(null);

  const { data: credentials = [] } = useQuery({
    queryKey: ["credentials"],
    queryFn: getCredentials,
  });

  const cloudCredentials = credentials.filter((c) => c.provider === provider);
  const tailscaleCredentials = credentials.filter(
    (c) => c.provider === "tailscale",
  );
  // A git host's token is also its container registry's docker password, so the
  // picker offers the credentials that can log in to the registry *this* image
  // lives on — ghcr.io for GitHub, registry.gitlab.com for GitLab, or whatever
  // host was set on a credential for a self-hosted install.
  const imageRegistry = registryHostOf(imageRef);
  const registryCredentials = credentials.filter(
    (c) => credentialRegistryHost(c) === imageRegistry,
  );
  // Docker Hub is not something a saved git token logs in to; offering a picker
  // there would only invite a credential that cannot work.
  const needsRegistryLogin = imageRegistry !== "" && imageRegistry !== "docker.io";

  const create = useMutation({
    mutationFn: createHost,
    onSuccess: () => {
      toast({
        title: "Creating the host",
        description: "This takes a few minutes. The status updates here.",
      });
      onDone();
    },
    onError: (err: Error) =>
      toast({
        title: "Could not create the host",
        description: err.message,
        variant: "destructive",
      }),
  });

  // Base UI's Select emits null when a selection is cleared; every field here
  // is required, so a null is ignored rather than written as an empty value.
  const onProviderChange = (value: string | null) => {
    if (value === "docker-endpoint") {
      setProvider(value);
      setCredentialId(null);
      return;
    }
    if (value !== "civo" && value !== "aws") return;
    const p = value;
    setProvider(p);
    // Region and size are provider-specific; carrying them over would send
    // values the other provider's Terraform module rejects.
    setRegion(HOST_REGIONS[p][0]);
    setSize(HOST_SIZES[p][2].value);
    // A Civo key cannot launch an EC2 instance: clear the selection so the
    // picker never shows a credential the other provider would reject.
    setCredentialId(null);
  };

  const sizeLabel = onEndpoint
    ? ""
    : (HOST_SIZES[provider as "civo" | "aws"].find((s) => s.value === size)?.label ?? size);

  return (
    <div className="space-y-4 rounded-lg border p-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="host-name">Name</Label>
          <Input
            id="host-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="nexus-host"
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="host-provider">Provider</Label>
          <Select value={provider} onValueChange={onProviderChange}>
            <SelectTrigger id="host-provider">
              <SelectValue>
                {(v) =>
                  v === "docker-endpoint" ? "Docker endpoint" : v === "aws" ? "AWS EC2" : "Civo"
                }
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="civo">Civo</SelectItem>
              <SelectItem value="aws">AWS EC2</SelectItem>
              {endpoints.length > 0 && (
                <SelectItem value="docker-endpoint">Docker endpoint (a machine you have)</SelectItem>
              )}
            </SelectContent>
          </Select>
        </div>

        {onEndpoint && (
          <div className="space-y-2 sm:col-span-2">
            <Label htmlFor="host-endpoint">Machine</Label>
            <Select
              value={dockerEndpointId ?? ""}
              onValueChange={(v) => v && setDockerEndpointId(v)}
            >
              <SelectTrigger id="host-endpoint">
                <SelectValue>
                  {(v) => endpoints.find((e) => e.id === v)?.name ?? "Pick an endpoint"}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {endpoints.map((e) => (
                  <SelectItem key={e.id} value={e.id}>
                    {e.name} · {e.host.replace(/^ssh:\/\//, "")}
                    {e.arch ? ` · ${e.arch}` : ""}
                    {e.memTotalMb != null ? ` · ${Math.round(e.memTotalMb / 1024)} GB RAM` : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}

        {!onEndpoint && (<>
        <div className="space-y-2">
          <Label htmlFor="host-region">Region</Label>
          <Select
            value={region}
            onValueChange={(v) => v && setRegion(v)}
          >
            <SelectTrigger id="host-region">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {HOST_REGIONS[provider as "civo" | "aws"].map((r) => (
                <SelectItem key={r} value={r}>
                  {r}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-2">
          <Label htmlFor="host-size">Size</Label>
          <Select value={size} onValueChange={(v) => v && setSize(v)}>
            <SelectTrigger id="host-size">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {HOST_SIZES[provider as "civo" | "aws"].map((s) => (
                <SelectItem key={s.value} value={s.value}>
                  {s.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        </>)}
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        {!onEndpoint && (
          <CredentialField
            id="host-credential"
            label={provider === "aws" ? "AWS credential" : "Civo credential"}
            credentials={cloudCredentials}
            value={credentialId}
            onChange={setCredentialId}
            empty={`No ${provider === "aws" ? "AWS" : "Civo"} credential saved (Settings → Cloud).`}
          />
        )}
        <CredentialField
          id="host-tailscale-credential"
          label="Tailscale auth key"
          credentials={tailscaleCredentials}
          value={tailscaleCredentialId}
          onChange={setTailscaleCredentialId}
          empty="No Tailscale auth key saved (Settings → Cloud)."
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="host-image">Image</Label>
        <Input
          id="host-image"
          value={imageRef}
          onChange={(e) => setImageRef(e.target.value)}
          className="font-mono text-sm"
        />
        <p className="text-sm text-muted-foreground">
          Pulled at boot. A private package needs a registry credential below.
        </p>
      </div>

      {needsRegistryLogin && (
        <CredentialField
          id="host-registry-credential"
          label={`Registry credential · ${imageRegistry}`}
          credentials={registryCredentials}
          value={registryCredentialId}
          onChange={setRegistryCredentialId}
          optional
          showProvider
          empty={`No saved git token logs in to ${imageRegistry}. Add one in Settings → Git — set its registry host if it is a self-hosted install. Only needed if the image is private.`}
          hint={`The token the host runs docker login with against ${imageRegistry}. It needs registry read access to that image; a public image needs none.`}
        />
      )}

      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <Label className="text-base font-medium">
            Install the embedding model
          </Label>
          <p className="text-sm text-muted-foreground">
            Needed for semantic search and ⌘K. Adds a few minutes to the first
            boot.
          </p>
        </div>
        <Switch
          checked={pullEmbeddingModel}
          onCheckedChange={setPullEmbeddingModel}
        />
      </div>

      {onEndpoint ? (
        <p className="text-sm text-muted-foreground">
          Runs as containers on <strong>{endpoint?.name ?? "the endpoint"}</strong>&apos;s
          Docker — nothing is billed and nothing is installed on the machine
          itself. It publishes no port there: only your tailnet can reach it.
        </p>
      ) : (
        <p className="text-sm text-muted-foreground">
          This launches a <strong>{sizeLabel}</strong> instance on {provider} and
          starts billing immediately.
        </p>
      )}

      <div className="flex gap-2">
        <Button
          onClick={() =>
            create.mutate({
              name,
              provider,
              dockerEndpointId: onEndpoint ? dockerEndpointId : null,
              credentialId: onEndpoint ? null : credentialId,
              tailscaleCredentialId,
              registryCredentialId: needsRegistryLogin
                ? registryCredentialId
                : null,
              region,
              size,
              imageRef,
              pullEmbeddingModel,
            })
          }
          disabled={
            !name.trim() || !imageRef.trim() || create.isPending || (onEndpoint && !dockerEndpointId)
          }
        >
          {create.isPending && (
            <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />
          )}
          Create host
        </Button>
        <Button variant="ghost" onClick={onCancel} disabled={create.isPending}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
