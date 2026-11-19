/**
 * One authenticated read against a provider, shared by the checks. The secret
 * travels only in the headers the caller passes — never in the URL, which is
 * what ends up in logs and error messages.
 */

import type { CheckLine, CredentialCheck, Fetch } from "./types";

export type Probe =
  | { reached: true; status: number; headers: Headers; body: unknown }
  | { reached: false; error: string };

export async function probe(fetchFn: Fetch, url: string, headers: Record<string, string>): Promise<Probe> {
  try {
    const res = await fetchFn(url, { headers, signal: AbortSignal.timeout(10_000) });
    const text = await res.text().catch(() => "");
    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch {
      // not JSON — keep the text for error details
    }
    return { reached: true, status: res.status, headers: res.headers, body };
  } catch (err) {
    return { reached: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** A result for a credential that could not be checked or was refused. */
export function failed(
  checkedAt: string,
  checks: CheckLine[],
  status: CredentialCheck["status"] = "fail",
): CredentialCheck {
  return { status, identity: null, expiresAt: null, scopes: null, checks, checkedAt };
}

/** The standard lines for "did the provider answer, and did it accept it". */
export function answerLines(p: Probe, provider: string): { accepted: boolean; lines: CheckLine[] } {
  if (!p.reached) {
    return { accepted: false, lines: [{ label: `${provider} answered`, ok: false, detail: `Could not reach ${provider}: ${p.error}` }] };
  }
  if (p.status === 401) {
    return {
      accepted: false,
      lines: [{ label: `${provider} accepts it`, ok: false, detail: `${provider} rejected it — expired, revoked, or not a key for ${provider}.` }],
    };
  }
  if (p.status >= 400) {
    return { accepted: false, lines: [{ label: `${provider} accepts it`, ok: false, detail: `${provider} answered ${p.status}.` }] };
  }
  return { accepted: true, lines: [{ label: `${provider} accepts it`, ok: true }] };
}

export const daysUntil = (iso: string, now: Date) => (new Date(iso).getTime() - now.getTime()) / 86_400_000;
