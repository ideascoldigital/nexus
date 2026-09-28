"use client";

import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { Check, Container, Laptop } from "lucide-react";

import { getDockerEndpoints, getHostEndpointKey } from "@/services/docker-endpoints";

/**
 * Which Docker a local sandbox runs on (spec 26): this machine, or another
 * one's daemon added in Settings → Cloud. Renders nothing until an endpoint
 * exists, so the common case — one machine — sees no new choice at all.
 */
export function DockerEndpointPicker({
  value,
  onChange,
  mountOnlyRepos,
}: {
  value: string | null;
  onChange: (endpointId: string | null) => void;
  /** Repos with a local folder and no clone URL — another machine can't see them. */
  mountOnlyRepos: string[];
}) {
  const endpoints = useQuery({
    queryKey: ["docker-endpoints"],
    queryFn: getDockerEndpoints,
  });
  // A Nexus host has no Docker of its own (spec 27 phase 6): "This machine"
  // is not an option there, and an endpoint is the only way to run locally.
  const host = useQuery({ queryKey: ["host-endpoint-key"], queryFn: getHostEndpointKey });
  const isHost = host.data?.isHost ?? false;
  const list = endpoints.data ?? [];
  useEffect(() => {
    if (isHost && value === null && list.length > 0 && mountOnlyRepos.length === 0) onChange(list[0].id);
  }, [isHost, value, list, mountOnlyRepos.length, onChange]);

  if (list.length === 0) {
    return isHost ? (
      <p className="rounded-md border border-amber-500/40 bg-amber-500/5 p-2.5 text-xs text-muted-foreground">
        This Nexus host has no Docker of its own. Register the machine it runs on (or another) under{" "}
        <Link href="/settings?tab=cloud" className="underline underline-offset-2">
          Settings → Cloud → Docker endpoints
        </Link>
        , then pick it here.
      </p>
    ) : null;
  }

  const blocked = mountOnlyRepos.length > 0;
  const options = [
    ...(isHost
      ? []
      : [{ id: null as string | null, name: "This machine", detail: "Docker on the machine running Nexux", icon: Laptop, disabled: false }]),
    ...list.map((ep) => ({
      id: ep.id as string | null,
      name: ep.name,
      detail: [
        ep.host.replace(/^ssh:\/\//, ""),
        ep.arch,
        ep.memTotalMb != null ? `${Math.round(ep.memTotalMb / 1024)} GB RAM` : null,
        ep.lastError ? "last check failed" : null,
      ]
        .filter(Boolean)
        .join(" · "),
      icon: Container,
      disabled: blocked,
    })),
  ];

  return (
    <div className="space-y-2">
      <div>
        <h4 className="text-xs font-medium">Which Docker</h4>
        <p className="text-[11px] text-muted-foreground">
          Another machine&apos;s CPU and memory, this dashboard.{" "}
          <Link href="/settings?tab=cloud" className="underline underline-offset-2">
            Manage endpoints
          </Link>
        </p>
      </div>
      <div className="grid gap-2">
        {options.map((o) => {
          const selected = value === o.id;
          return (
            <button
              key={o.id ?? "this-machine"}
              type="button"
              disabled={o.disabled}
              onClick={() => onChange(o.id)}
              className={`flex items-start gap-3 rounded-lg border p-2.5 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
                selected
                  ? "border-primary/60 bg-primary/10"
                  : "border-border/60 bg-muted/20 hover:border-border"
              }`}
            >
              <o.icon
                className={`mt-0.5 h-4 w-4 shrink-0 ${selected ? "text-primary" : "text-muted-foreground"}`}
              />
              <span className="min-w-0">
                <span className="block text-xs font-medium">{o.name}</span>
                <span className="block truncate text-[11px] text-muted-foreground">
                  {o.detail}
                </span>
              </span>
              {selected && <Check className="ml-auto h-4 w-4 shrink-0 text-primary" />}
            </button>
          );
        })}
      </div>
      {blocked && (
        <p className="text-[11px] text-amber-300/90">
          Other machines can&apos;t see local folders ({mountOnlyRepos.join(", ")}) —
          give {mountOnlyRepos.length === 1 ? "it" : "them"} a clone URL to run
          there.
        </p>
      )}
    </div>
  );
}
