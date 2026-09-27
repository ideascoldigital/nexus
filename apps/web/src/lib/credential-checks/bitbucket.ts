/**
 * Test a Bitbucket token (spec 28).
 *
 * Only bearer-style tokens (repository / project / workspace access tokens)
 * can be tested on their own: an app password also needs its username, which
 * the credential does not store. `GET /2.0/user` names the account for a user
 * token; a repository access token may not read the user at all, which is
 * reported as "cannot be told from here", not as a failure.
 */

import { answerLines, failed, probe } from "./http";
import { shapeProblems } from "./shape";
import type { CheckLine, CredentialCheck, Fetch } from "./types";

export async function checkBitbucket(
  token: string,
  deps: { fetch?: Fetch; now?: () => Date } = {},
): Promise<CredentialCheck> {
  const fetchFn = deps.fetch ?? fetch;
  const checkedAt = (deps.now?.() ?? new Date()).toISOString();
  const shape = shapeProblems("bitbucket", token);
  const shapeLines: CheckLine[] = shape.map((p) => ({ label: "looks like a token", ok: false, detail: p.message }));
  if (shape.some((p) => p.fatal)) return failed(checkedAt, shapeLines);

  const res = await probe(fetchFn, "https://api.bitbucket.org/2.0/user", { Authorization: `Bearer ${token.trim()}` });
  if (res.reached && res.status === 403) {
    // Valid, but scoped to repositories rather than the account.
    return {
      status: "ok",
      identity: null,
      expiresAt: null,
      scopes: null,
      checks: [
        ...shapeLines,
        { label: "Bitbucket accepts it", ok: true },
        { label: "account-wide access", ok: null, detail: "a repository or workspace token — its access is per repository" },
      ],
      checkedAt,
    };
  }
  const answer = answerLines(res, "Bitbucket");
  if (!answer.accepted) return failed(checkedAt, [...shapeLines, ...answer.lines]);
  const body = (res as { body: { display_name?: string; username?: string } }).body;
  const header = (res as { headers: Headers }).headers.get("x-oauth-scopes");
  const scopes = header ? header.split(/[,\s]+/).filter(Boolean) : null;
  return {
    status: shape.length > 0 ? "warn" : "ok",
    identity: body?.username ?? body?.display_name ?? null,
    expiresAt: null,
    scopes,
    checks: [...shapeLines, ...answer.lines],
    checkedAt,
  };
}
