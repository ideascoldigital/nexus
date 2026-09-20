"use client";

// System resources: this machine, then every sandbox running on it.
//
// The page the status bar's meters lead to. It answers the question the bar
// can only hint at — *what* is using the disk, and is it a sandbox or the host
// itself — because the incident that prompted all of this was a host at 100%
// where the fix was `docker image prune` and the error message said
// "check the registry credentials".

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, Cpu, HardDrive, MemoryStick, Monitor } from "lucide-react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { SandboxMetric } from "@/lib/sandbox-metrics";
import type { Metric, SystemMetrics } from "@/lib/system-metrics";

type MetricsResponse = { system: SystemMetrics; sandboxes: SandboxMetric[] };

/** Shared by the header and every row, so the columns cannot drift apart. */
const SANDBOX_COLS = "grid-cols-[1fr_4rem_9rem_4rem]";

function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

/** Amber at 80, red at 90 — disk is fine until it suddenly is not. */
function barTone(percent: number | null): string {
  if (percent === null) return "bg-muted";
  if (percent >= 90) return "bg-destructive";
  if (percent >= 80) return "bg-amber-400";
  return "bg-primary";
}

function Gauge({
  icon,
  label,
  metric,
}: {
  icon: React.ReactNode;
  label: string;
  metric: Metric | null;
}) {
  const percent = metric?.usedPercent ?? null;
  const free =
    metric?.totalBytes && metric.usedBytes !== null && metric.usedBytes !== undefined
      ? metric.totalBytes - metric.usedBytes
      : null;

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-sm font-medium">
          {icon}
          {label}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        <div className="flex items-baseline justify-between">
          {/* "—" rather than "0%": not measurable and genuinely idle are
              different facts, and only one of them is good news. */}
          <span className="font-mono text-2xl">
            {percent === null ? "—" : `${Math.round(percent)}%`}
          </span>
          {free !== null && (
            <span className="font-mono text-xs text-muted-foreground">
              {formatBytes(free)} free
            </span>
          )}
        </div>
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
          <div
            className={`h-full transition-all ${barTone(percent)}`}
            style={{ width: `${Math.min(100, percent ?? 0)}%` }}
          />
        </div>
        {metric?.detail && (
          <p className="truncate font-mono text-[10px] text-muted-foreground">
            {metric.detail}
          </p>
        )}
        {metric?.totalBytes ? (
          <p className="font-mono text-[10px] text-muted-foreground">
            {formatBytes(metric.usedBytes)} of {formatBytes(metric.totalBytes)}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}

export default function SystemStatsPage() {
  // Disk per sandbox costs an exec each, which is why the bar never asks for
  // it and this page always does.
  const { data, isLoading, isError } = useQuery<MetricsResponse>({
    queryKey: ["system-metrics", "full"],
    queryFn: async () => {
      const res = await fetch("/api/metrics?sandboxes=1&disk=1");
      if (!res.ok) throw new Error("Could not read system metrics");
      return res.json();
    },
    refetchInterval: 10_000,
    retry: false,
  });

  return (
    <div className="mx-auto max-w-5xl space-y-6 p-6">
      <div className="flex items-center gap-3">
        <Link
          href="/settings"
          className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" />
          Settings
        </Link>
      </div>

      <div>
        <h1 className="text-xl font-semibold">System</h1>
        <p className="text-sm text-muted-foreground">
          {data?.system
            ? `${data.system.hostname} · ${data.system.platform}`
            : "This machine and the sandboxes running on it."}
        </p>
      </div>

      {isError && (
        <p className="text-sm text-destructive">
          Could not read this machine&apos;s metrics.
        </p>
      )}
      {isLoading && !data && (
        <p className="text-sm text-muted-foreground">Reading…</p>
      )}

      {data?.system && (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Gauge
            icon={<MemoryStick className="h-4 w-4 text-muted-foreground" />}
            label="Memory"
            metric={data.system.memory}
          />
          <Gauge
            icon={<Cpu className="h-4 w-4 text-muted-foreground" />}
            label="CPU"
            metric={data.system.cpu}
          />
          <Gauge
            icon={<HardDrive className="h-4 w-4 text-muted-foreground" />}
            label="Disk"
            metric={data.system.disk}
          />
          {/* Absent on Apple Silicon and on any host without nvidia-smi, which
              is most of them; a card reading "—" forever would imply a fault. */}
          {data.system.gpu && (
            <Gauge
              icon={<Monitor className="h-4 w-4 text-muted-foreground" />}
              label="GPU"
              metric={data.system.gpu}
            />
          )}
        </div>
      )}

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-medium">
            Sandboxes
            {data?.sandboxes?.length ? (
              <span className="ml-2 font-mono text-xs text-muted-foreground">
                {data.sandboxes.length} running
              </span>
            ) : null}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {!data?.sandboxes?.length ? (
            <p className="text-sm text-muted-foreground">
              No sandboxes running on this machine.
            </p>
          ) : (
            <div className="space-y-1">
              {/* One shared column definition, in fixed widths rather than
                  `auto`: the header and each row are separate grids, so `auto`
                  sizes every one of them to its own content and the columns
                  drift apart. Memory is the widest because it carries a pair
                  ("336 MB / 10 GB"); the rest are short percentages. */}
              <div
                className={`grid ${SANDBOX_COLS} gap-4 border-b pb-1 font-mono text-[10px] uppercase text-muted-foreground`}
              >
                <span>name</span>
                <span className="text-right">cpu</span>
                <span className="text-right">memory</span>
                <span className="text-right">disk</span>
              </div>
              {data.sandboxes.map((s) => (
                <div
                  key={s.name}
                  className={`grid ${SANDBOX_COLS} items-center gap-4 py-1 font-mono text-xs`}
                >
                  <span className="truncate">{s.name}</span>
                  <span className="text-right text-muted-foreground">
                    {s.cpuPercent === null ? "—" : `${s.cpuPercent}%`}
                  </span>
                  <span className="text-right text-muted-foreground">
                    {s.memUsedBytes === null
                      ? "—"
                      : `${formatBytes(s.memUsedBytes)} / ${formatBytes(s.memLimitBytes)}`}
                  </span>
                  <span
                    className={`text-right ${
                      (s.diskPercent ?? 0) >= 90
                        ? "text-destructive"
                        : (s.diskPercent ?? 0) >= 80
                          ? "text-amber-400"
                          : "text-muted-foreground"
                    }`}
                  >
                    {s.diskPercent === null || s.diskPercent === undefined
                      ? "—"
                      : `${s.diskPercent}%`}
                  </span>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
