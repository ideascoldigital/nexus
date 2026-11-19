/**
 * Test an LLM provider key (spec 16's credentials; spec 28): each provider's
 * cheapest authenticated read, so a test never spends tokens.
 */

import { answerLines, failed, probe } from "./http";
import { shapeProblems } from "./shape";
import type { CheckLine, CredentialCheck, Fetch } from "./types";

type Endpoint = { name: string; url: string; headers: (key: string) => Record<string, string> };

const ENDPOINTS: Record<string, Endpoint> = {
  "anthropic-key": {
    name: "Anthropic",
    url: "https://api.anthropic.com/v1/models",
    headers: (k) => ({ "x-api-key": k, "anthropic-version": "2023-06-01" }),
  },
  openai: { name: "OpenAI", url: "https://api.openai.com/v1/models", headers: (k) => ({ Authorization: `Bearer ${k}` }) },
  // /key rather than /models: it also says the key's credit limit and usage.
  openrouter: { name: "OpenRouter", url: "https://openrouter.ai/api/v1/key", headers: (k) => ({ Authorization: `Bearer ${k}` }) },
  // The header, not ?key= — a key in the URL is a key in every log line.
  google: {
    name: "Google AI",
    url: "https://generativelanguage.googleapis.com/v1beta/models",
    headers: (k) => ({ "x-goog-api-key": k }),
  },
  "xai-llm": { name: "xAI", url: "https://api.x.ai/v1/models", headers: (k) => ({ Authorization: `Bearer ${k}` }) },
  zai: { name: "Z.ai", url: "https://api.z.ai/api/paas/v4/models", headers: (k) => ({ Authorization: `Bearer ${k}` }) },
};

export const LLM_CHECKABLE = Object.keys(ENDPOINTS);

export async function checkLlmKey(
  provider: string,
  key: string,
  deps: { fetch?: Fetch; now?: () => Date } = {},
): Promise<CredentialCheck | null> {
  const ep = ENDPOINTS[provider];
  if (!ep) return null;
  const fetchFn = deps.fetch ?? fetch;
  const checkedAt = (deps.now?.() ?? new Date()).toISOString();
  const shape = shapeProblems(provider, key);
  const shapeLines: CheckLine[] = shape.map((p) => ({ label: "looks like a key", ok: false, detail: p.message }));
  if (shape.some((p) => p.fatal)) return failed(checkedAt, shapeLines);

  const res = await probe(fetchFn, ep.url, ep.headers(key.trim()));
  // Google answers a bad key with 400/403, not 401.
  if (provider === "google" && res.reached && (res.status === 400 || res.status === 403)) {
    return failed(checkedAt, [...shapeLines, { label: `${ep.name} accepts it`, ok: false, detail: `${ep.name} rejected it — invalid or restricted key.` }]);
  }
  const answer = answerLines(res, ep.name);
  if (!answer.accepted) return failed(checkedAt, [...shapeLines, ...answer.lines]);

  const lines: CheckLine[] = [...shapeLines, ...answer.lines];
  let identity: string | null = null;
  let status: CredentialCheck["status"] = shape.length ? "warn" : "ok";

  if (provider === "openrouter") {
    const d = ((res as { body: { data?: { label?: string; limit?: number | null; usage?: number; limit_remaining?: number | null } } }).body?.data) ?? {};
    identity = d.label ?? null;
    const remaining = d.limit_remaining ?? (d.limit != null && d.usage != null ? d.limit - d.usage : null);
    if (remaining != null) {
      const low = remaining < 1;
      lines.push({ label: "has credit left", ok: !low, detail: `$${remaining.toFixed(2)} of $${(d.limit ?? 0).toFixed(2)} left` });
      if (low) status = "warn";
    } else {
      lines.push({ label: "has credit left", ok: null, detail: "no limit set on this key" });
    }
  }
  return { status, identity, expiresAt: null, scopes: null, checks: lines, checkedAt };
}
