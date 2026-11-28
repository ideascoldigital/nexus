// The step a sandbox being set up is on, in a few words, for the chat's
// status bar (spec 39): the bootstrap's own "[nexux] …" lines once it runs
// inside the machine, before that the launcher's "· …" provisioning steps.
// Warnings and apt noise are skipped. Pure.

const clean = (s: string) => {
  const t = s.replace(/\s+—.*$/, "").replace(/\s+\(.*\)$/, "").replace(/\s+\$\(.*$/, "").trim();
  return t ? t[0]!.toUpperCase() + t.slice(1) : "";
};

export function sandboxPhase(provisionLog: string | null | undefined, bootstrapLog: string | null | undefined): string | null {
  const steps = (bootstrapLog ?? "")
    .split("\n")
    .map((l) => /^\[nexux\] (.+)$/.exec(l.trim())?.[1] ?? null)
    .filter((l): l is string => Boolean(l) && !/^(WARN|FATAL|ACTION REQUIRED)\b/.test(l!) && !l!.includes("://"));
  const fromBootstrap = steps.at(-1);
  if (fromBootstrap) return clean(fromBootstrap.replace(/^bootstrap started.*/, "starting the setup"));
  const segments = (provisionLog ?? "")
    .split(/\s*·\s*|\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  const last = segments.at(-1);
  return last ? clean(last.replace(/^bootstrap started.*/, "starting the setup")) : null;
}

/** "45s", "3m 05s", "1h 02m". */
export function elapsedLabel(fromIso: string | Date, now: number = Date.now()): string {
  const s = Math.max(0, Math.floor((now - new Date(fromIso).getTime()) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}
