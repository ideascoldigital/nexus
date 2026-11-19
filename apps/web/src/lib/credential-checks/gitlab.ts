/**
 * Test a GitLab token (spec 28), on gitlab.com or the self-hosted instance the
 * credential names.
 *
 * `GET /api/v4/personal_access_tokens/self` answers what the token is — its
 * scopes, expiry and whether it is still active — and `GET /user` whose it is.
 * Instances older than 15.5 lack the first; there the scopes are "cannot be
 * told from here" rather than guessed.
 */

import { webHostOfRegistry } from "@/lib/git-credentials";

import { answerLines, daysUntil, failed, probe } from "./http";
import { shapeProblems } from "./shape";
import { EXPIRY_WARN_DAYS, type CheckLine, type CredentialCheck, type Fetch } from "./types";

const CAPABILITIES: Array<{ label: string; scopes: string[]; needed: boolean; why?: string }> = [
  { label: "clone private repos", scopes: ["read_repository", "api"], needed: true },
  { label: "push branches", scopes: ["write_repository", "api"], needed: true },
  { label: "open merge requests", scopes: ["api"], needed: false, why: "only for agents that open MRs" },
  {
    label: "pull private images from the registry",
    scopes: ["read_registry", "api"],
    needed: false,
    why: "only for a Nexus host whose image is private",
  },
];

export async function checkGitLab(
  token: string,
  opts: { registryHost?: string | null },
  deps: { fetch?: Fetch; now?: () => Date } = {},
): Promise<CredentialCheck> {
  const fetchFn = deps.fetch ?? fetch;
  const now = deps.now?.() ?? new Date();
  const checkedAt = now.toISOString();
  const host = webHostOfRegistry(opts.registryHost) ?? "gitlab.com";
  const shape = shapeProblems("gitlab", token);
  const shapeLines: CheckLine[] = shape.map((p) => ({ label: "looks like a token", ok: false, detail: p.message }));
  if (shape.some((p) => p.fatal)) return failed(checkedAt, shapeLines);

  const headers = { "PRIVATE-TOKEN": token.trim() };
  const user = await probe(fetchFn, `https://${host}/api/v4/user`, headers);
  const answer = answerLines(user, `GitLab (${host})`);
  if (!answer.accepted) return failed(checkedAt, [...shapeLines, ...answer.lines]);
  const username = ((user as { body: { username?: string } }).body?.username) ?? null;

  const self = await probe(fetchFn, `https://${host}/api/v4/personal_access_tokens/self`, headers);
  const info =
    self.reached && self.status === 200
      ? (self.body as { scopes?: string[]; expires_at?: string | null; active?: boolean })
      : null;
  const scopes = info?.scopes ?? null;
  const expiresAt = info?.expires_at ? new Date(`${info.expires_at}T00:00:00Z`).toISOString() : null;

  const lines: CheckLine[] = [...shapeLines, ...answer.lines];
  if (info?.active === false) lines.push({ label: "active", ok: false, detail: "GitLab says this token is no longer active" });
  for (const cap of CAPABILITIES) {
    lines.push(
      scopes === null
        ? { label: cap.label, ok: null, detail: "this instance does not say which scopes a token has" }
        : cap.scopes.some((s) => scopes.includes(s))
          ? { label: cap.label, ok: true }
          : { label: cap.label, ok: false, detail: `needs ${cap.scopes[0]}${cap.why ? ` — ${cap.why}` : ""}` },
    );
  }

  let status: CredentialCheck["status"] = "ok";
  if (expiresAt) {
    const days = daysUntil(expiresAt, now);
    lines.push({
      label: "not about to expire",
      ok: days > EXPIRY_WARN_DAYS,
      detail: days <= 0 ? "expired" : `expires in ${Math.ceil(days)} day${Math.ceil(days) === 1 ? "" : "s"}`,
    });
    if (days <= EXPIRY_WARN_DAYS) status = "warn";
  }
  const missingNeeded = scopes !== null && CAPABILITIES.some((c) => c.needed && !c.scopes.some((s) => scopes.includes(s)));
  if (missingNeeded || info?.active === false || shape.length > 0) status = "warn";

  return { status, identity: username ? `${username} @ ${host}` : host, expiresAt, scopes, checks: lines, checkedAt };
}
