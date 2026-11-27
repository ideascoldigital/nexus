// The models and reasoning levels a bot can run on (claude --model / --effort),
// for the composer's picker. Pure, for tests.

export const CLAUDE_MODELS = [
  { id: "claude-opus-5-5", label: "Claude Opus 5.5", short: "Opus 5.5" },
  { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5", short: "Sonnet 5.5" },
  { id: "claude-fable-5-2", label: "Claude Fable 5.2", short: "Fable 5.2" },
  { id: "claude-haiku-5-5", label: "Claude Haiku 5.5", short: "Haiku 5.5" },
] as const;

export const EFFORTS = [
  { id: "low", label: "Low" },
  { id: "medium", label: "Medium" },
  { id: "high", label: "High" },
  { id: "xhigh", label: "Extra High" },
  { id: "max", label: "Max" },
] as const;

const ALIASES: Record<string, string> = { opus: "Opus", sonnet: "Sonnet", haiku: "Haiku", fable: "Fable" };

/** What the chip says for a bot's model: its short name, an alias capitalised, or the id itself. */
export function modelShortLabel(model: string | null | undefined): string {
  if (!model) return "Default";
  const known = CLAUDE_MODELS.find((m) => m.id === model);
  if (known) return known.short;
  return ALIASES[model.toLowerCase()] ?? model;
}

export function effortLabel(effort: string | null | undefined): string | null {
  return EFFORTS.find((e) => e.id === effort)?.label ?? null;
}

/** The models matching a search; a search naming none can be used as a model id as typed. */
export function searchModels(query: string) {
  const q = query.trim().toLowerCase();
  const models = q ? CLAUDE_MODELS.filter((m) => `${m.label} ${m.id}`.toLowerCase().includes(q)) : [...CLAUDE_MODELS];
  const custom = q && models.length === 0 && /^[a-z0-9][a-z0-9.\-_[\]]{1,59}$/i.test(query.trim()) ? query.trim() : null;
  return { models, custom };
}
