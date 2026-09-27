/**
 * Test a GitHub token (spec 28): who it is, when it expires, what it can do.
 *
 * One request, `GET /user`, answers all three: the body names the account,
 * `github-authentication-token-expiration` the expiry, and `X-OAuth-Scopes`
 * the scopes — for classic and OAuth tokens. Fine-grained tokens list no
 * scopes; their lines are "cannot be told from here", and the per-repo checks
 * (phase 4) are where they get answered.
 */

import { shapeProblems } from "./shape";
import { EXPIRY_WARN_DAYS, type CheckLine, type CredentialCheck, type Fetch } from "./types";

const API = "https://api.github.com";

/** What Nexux uses a GitHub token for, and the scope each needs. */
const CAPABILITIES: Array<{ label: string; scopes: string[]; needed: boolean; why?: string }> = [
  { label: "clone and push private repos", scopes: ["repo"], needed: true },
  {
    label: "pull private images from ghcr.io",
    scopes: ["read:packages", "write:packages"],
    needed: false,
    why: "only for a Nexus host whose image is private",
  },
  {
    label: "push changes to GitHub Actions workflows",
    scopes: ["workflow"],
    needed: false,
    why: "only when an agent edits .github/workflows",
  },
];

/** `2026-10-01 00:00:00 UTC` → ISO, or null. */
export function parseGitHubExpiry(raw: string | null): string | null {
  if (!raw) return null;
  const d = new Date(raw.replace(" UTC", "Z").replace(" ", "T"));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export async function checkGitHub(
  token: string,
  deps: { fetch?: Fetch; now?: () => Date } = {},
): Promise<CredentialCheck> {
  const fetchFn = deps.fetch ?? fetch;
  const now = deps.now?.() ?? new Date();
  const checkedAt = now.toISOString();
  const shape = shapeProblems("github", token);
  const shapeLines: CheckLine[] = shape.map((p) => ({ label: "looks like a token", ok: false, detail: p.message }));

  if (shape.some((p) => p.fatal)) {
    return { status: "fail", identity: null, expiresAt: null, scopes: null, checks: shapeLines, checkedAt };
  }

  let res: Response;
  try {
    res = await fetchFn(`${API}/user`, {
      headers: {
        Authorization: `Bearer ${token.trim()}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    return {
      status: "fail",
      identity: null,
      expiresAt: null,
      scopes: null,
      checks: [
        ...shapeLines,
        { label: "GitHub answered", ok: false, detail: `Could not reach GitHub: ${err instanceof Error ? err.message : String(err)}` },
      ],
      checkedAt,
    };
  }

  if (res.status === 401) {
    return {
      status: "fail",
      identity: null,
      expiresAt: null,
      scopes: null,
      checks: [
        ...shapeLines,
        { label: "GitHub accepts it", ok: false, detail: "GitHub rejected it — expired, revoked, or not a token." },
      ],
      checkedAt,
    };
  }
  if (!res.ok) {
    return {
      status: "fail",
      identity: null,
      expiresAt: null,
      scopes: null,
      checks: [...shapeLines, { label: "GitHub accepts it", ok: false, detail: `GitHub answered ${res.status}.` }],
      checkedAt,
    };
  }

  const user = (await res.json().catch(() => ({}))) as { login?: string };
  const scopeHeader = res.headers.get("x-oauth-scopes");
  // Absent (not merely empty) for fine-grained tokens and app tokens.
  const scopes = scopeHeader === null ? null : scopeHeader.split(",").map((s) => s.trim()).filter(Boolean);
  const expiresAt = parseGitHubExpiry(res.headers.get("github-authentication-token-expiration"));

  const lines: CheckLine[] = [...shapeLines, { label: "GitHub accepts it", ok: true }];
  for (const cap of CAPABILITIES) {
    lines.push(
      scopes === null
        ? { label: cap.label, ok: null, detail: "fine-grained token — its access is per repository, not listable here" }
        : cap.scopes.some((s) => scopes.includes(s))
          ? { label: cap.label, ok: true }
          : { label: cap.label, ok: false, detail: `needs ${cap.scopes[0]}${cap.why ? ` — ${cap.why}` : ""}` },
    );
  }

  let status: CredentialCheck["status"] = "ok";
  if (expiresAt) {
    const days = (new Date(expiresAt).getTime() - now.getTime()) / 86_400_000;
    lines.push({
      label: "not about to expire",
      ok: days > EXPIRY_WARN_DAYS,
      detail: days <= 0 ? "expired" : `expires in ${Math.ceil(days)} day${Math.ceil(days) === 1 ? "" : "s"}`,
    });
    if (days <= EXPIRY_WARN_DAYS) status = "warn";
  }
  // Missing what every sandbox needs is a warning; missing an optional scope
  // is shown on its line and left at that.
  if (scopes !== null && !scopes.includes("repo")) status = "warn";
  if (shape.length > 0) status = "warn";

  return { status, identity: user.login ?? null, expiresAt, scopes, checks: lines, checkedAt };
}
