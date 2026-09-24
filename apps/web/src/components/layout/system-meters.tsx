"use client";

// The machine's vitals in the status bar: memory, CPU, disk and — only where
// something can answer — GPU.
//
// This exists because a Nexus host ran out of disk and the product never said
// so. The first symptom was a docker pull failing with "could not pull — check
// the registry credentials", which named the wrong cause entirely; the real
// one had been sitting at 100% for weeks and `df` would have shown it in a
// second. A number that is always on screen is the cheapest possible version
// of that check.
//
// Thresholds are deliberately conservative. Disk is the one that ruins a host,
// and it ruins it suddenly: 90% is fine until an image extracts and then
// nothing works, so amber starts at 80 and red at 90 — early enough to act.

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";

import type { Metric, SystemMetrics } from "@/lib/system-metrics";

type MetricsResponse = { system: SystemMetrics };

const POLL_MS = 15_000;

/** Amber at 80, red at 90 — see the note above about disk failing suddenly. */
function toneFor(percent: number | null): string {
  if (percent === null) return "text-muted-foreground";
  if (percent >= 90) return "text-destructive";
  if (percent >= 80) return "text-amber-400";
  return "text-muted-foreground";
}

function formatBytes(bytes: number | null | undefined): string | null {
  if (bytes === null || bytes === undefined) return null;
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)}${units[unit]}`;
}

function Meter({ label, metric }: { label: string; metric: Metric }) {
  const { usedPercent } = metric;
  // "—" rather than "0%": a metric this machine cannot answer and a metric
  // that is genuinely at zero are different facts, and only one of them is
  // reassuring.
  const shown = usedPercent === null ? "—" : `${Math.round(usedPercent)}%`;
  const free =
    metric.totalBytes && metric.usedBytes !== null && metric.usedBytes !== undefined
      ? formatBytes(metric.totalBytes - metric.usedBytes)
      : null;

  return (
    <span
      className={`flex items-center gap-1 font-mono ${toneFor(usedPercent)}`}
      title={[
        `${label}: ${shown} used`,
        free ? `${free} free` : null,
        metric.detail,
      ]
        .filter(Boolean)
        .join(" · ")}
    >
      <span className="uppercase opacity-70">{label}</span>
      {shown}
    </span>
  );
}

export function SystemMeters() {
  const { data } = useQuery<MetricsResponse>({
    queryKey: ["system-metrics"],
    queryFn: async () => {
      const res = await fetch("/api/metrics");
      if (!res.ok) throw new Error("metrics failed");
      return res.json();
    },
    refetchInterval: POLL_MS,
    // A machine that cannot measure itself should not retry in a loop; the
    // next poll is soon enough.
    retry: false,
  });

  if (!data?.system) return null;
  const { memory, cpu, disk, gpu } = data.system;

  return (
    <Link
      href="/settings/system"
      className="tap-target flex items-center gap-2.5 rounded-sm px-1 hover:bg-accent hover:text-foreground"
      title="System and sandbox resources"
    >
      <Meter label="mem" metric={memory} />
      <Meter label="cpu" metric={cpu} />
      <Meter label="disk" metric={disk} />
      {/* Most machines have no GPU we can read; an empty slot is better than
          a permanent "—" implying something is broken. */}
      {gpu && <Meter label="gpu" metric={gpu} />}
    </Link>
  );
}
