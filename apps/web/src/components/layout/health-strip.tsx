"use client";

// Global health strip (design M5): ollama · terraform · civo · telegram as
// live dots in the app header. Green = ready, amber = not configured/down.

import { useQuery } from "@tanstack/react-query";

type Health = {
  ollama: boolean;
  terraform: boolean;
  civo: boolean;
  telegram: boolean;
};

const LABELS: Array<{ key: keyof Health; label: string }> = [
  { key: "ollama", label: "ollama" },
  { key: "terraform", label: "terraform" },
  { key: "civo", label: "civo" },
  { key: "telegram", label: "telegram" },
];

export function HealthStrip() {
  const { data } = useQuery<Health>({
    queryKey: ["global-health"],
    queryFn: async () => {
      const res = await fetch("/api/health");
      if (!res.ok) throw new Error("health failed");
      return res.json();
    },
    refetchInterval: 30_000,
    retry: false,
  });

  if (!data) return null;

  return (
    <div className="hidden md:flex items-center gap-2">
      {LABELS.map(({ key, label }) => (
        <span
          key={key}
          className={`flex items-center gap-1.5 rounded-full border border-border/70 bg-background px-2.5 py-1 font-mono text-[10.5px] ${
            data[key] ? "text-primary" : "text-amber-400"
          }`}
          title={`${label}: ${data[key] ? "ready" : "not available"}`}
        >
          <span
            className={`h-1.5 w-1.5 rounded-full ${
              data[key] ? "bg-primary" : "bg-amber-400"
            }`}
          />
          {label}
        </span>
      ))}
    </div>
  );
}
