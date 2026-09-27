/**
 * Test a Claude Code token (spec 28) — the OAuth token `claude setup-token`
 * prints, which sandboxes run Claude Code with.
 *
 * Anthropic's API may or may not accept that token for a plain read; when it
 * answers with anything but a clear yes or a clear 401, the result is "format
 * ok, not verifiable here" rather than a false failure. The only sure test is
 * running Claude Code with it, which costs a request of the user's plan.
 */

import { failed, probe } from "./http";
import { shapeProblems } from "./shape";
import type { CheckLine, CredentialCheck, Fetch } from "./types";

export async function checkClaude(
  token: string,
  deps: { fetch?: Fetch; now?: () => Date } = {},
): Promise<CredentialCheck> {
  const fetchFn = deps.fetch ?? fetch;
  const checkedAt = (deps.now?.() ?? new Date()).toISOString();
  const shape = shapeProblems("claude", token);
  const shapeLines: CheckLine[] = shape.map((p) => ({ label: "looks like a Claude Code token", ok: false, detail: p.message }));
  if (shape.some((p) => p.fatal)) return failed(checkedAt, shapeLines);

  const res = await probe(fetchFn, "https://api.anthropic.com/v1/models", {
    Authorization: `Bearer ${token.trim()}`,
    "anthropic-version": "2023-06-01",
    "anthropic-beta": "oauth-2025-04-20",
  });
  if (res.reached && res.status === 200) {
    return { status: shape.length ? "warn" : "ok", identity: null, expiresAt: null, scopes: null, checks: [...shapeLines, { label: "Anthropic accepts it", ok: true }], checkedAt };
  }
  if (res.reached && res.status === 401) {
    return failed(checkedAt, [...shapeLines, { label: "Anthropic accepts it", ok: false, detail: "Anthropic rejected it — expired or revoked. Run `claude setup-token` again." }]);
  }
  return {
    status: shape.length ? "warn" : "ok",
    identity: null,
    expiresAt: null,
    scopes: null,
    checks: [
      ...shapeLines,
      { label: "looks like a Claude Code token", ok: shape.length === 0 },
      {
        label: "Anthropic accepts it",
        ok: null,
        detail: res.reached
          ? `not verifiable without running Claude Code (the API answered ${res.status})`
          : `could not reach Anthropic: ${res.error}`,
      },
    ],
    checkedAt,
  };
}
