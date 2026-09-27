# 28 — Test a credential before something needs it

Status: **phases 1–2 and 5 shipped** (2026-09-27) — git hosts, Claude Code,
LLM keys, and Docker endpoints as sandbox targets. Phases 3–4 remain.

## Goal

Every saved credential gets a **Test** button that says, in one line, what
the credential actually is and what it can do — account, scopes, expiry,
access to the things this install will use it for — without having to find
out by launching a sandbox or creating a host.

## Why now

Three times in one session a credential was wrong and only a downstream
failure said so:

- A GitHub token saved as the text of the command meant to copy it
  (`gh auth token | pbcopy`, 22 characters). Nothing looked at it until the
  host's registry check refused it, and the message blamed the scope.
- Three valid GitHub tokens without `read:packages` — discovered only when a
  Nexus host tried to pull a private image.
- The only credential check in the product today is on **Connected
  accounts** (Integrations → GitHub, `PATCH /api/github/accounts/[id]`,
  `GET /user`). The credentials sandboxes and hosts actually use —
  `CloudCredential` rows in Settings → Cloud / Git / AI Providers — have none.

A token's problems are knowable in a second from the provider's own API. The
product just never asks.

## What a check returns

```ts
type CredentialCheck = {
  status: "ok" | "warn" | "fail";   // fail: unusable. warn: works, but not for everything
  identity: string | null;          // "jairoFernandez", "AWS 1234…/role", "Civo account ideas"
  expiresAt: string | null;         // when the provider says
  scopes: string[] | null;          // null when the provider cannot list them
  checks: Array<{ label: string; ok: boolean | null; detail?: string }>;
  checkedAt: string;
};
```

`checks` is the useful part: one line per capability that matters *to
Nexux*, with `ok: null` for "cannot be told from here" (never guessed as
true or false). Examples: "clone private repos (`repo`)", "pull
ghcr.io/ideascoldigital/nexus:edge", "push to galtex-invoice-sync-lambda".

The last result is stored on the row (`CloudCredential.lastCheck Json?`,
`lastCheckedAt DateTime?`), so the list shows a status dot without
re-checking on every render.

## Per provider

Every request goes **only to that provider's own API** (or the self-hosted
instance saved on the credential), with a 10 s timeout. The secret is never
in a URL, a log line or a response.

| Provider | Identity / validity | What it can do |
|---|---|---|
| **github** | `GET api.github.com/user` → login. Header `github-authentication-token-expiration` → `expiresAt`. | Classic / OAuth tokens: `X-OAuth-Scopes` header → `scopes`; checks for `repo` (private clone/push), `read:packages` (GHCR), `workflow`. Fine-grained tokens list no scopes → `scopes: null`, and the per-repo checks below are the answer. |
| **gitlab** | `GET <host>/api/v4/personal_access_tokens/self` → `scopes`, `expires_at`, `active`; `GET /user` → username. Host = `registryHost`'s web host or gitlab.com, as `selfHostedGitLabHost` already derives. | `read_repository` / `write_repository` / `read_registry` / `api`. |
| **bitbucket** | `GET api.bitbucket.org/2.0/user`. | Scopes from `x-oauth-scopes` when present; otherwise `null`. |
| **claude** (Claude Code token) | Format (`sk-ant-oat…`), then a `GET api.anthropic.com/v1/models` with the token as an OAuth bearer. If Anthropic answers that the call is not supported for this token type, the check reports *format ok, not verifiable here* (`ok: null`) rather than failing. | — |
| **LLM keys** (spec 16) | The provider's cheapest authenticated read: `GET /v1/models` (OpenAI, xAI, Anthropic key), `GET /api/v1/key` (OpenRouter — also returns credit limit and usage), `GET v1beta/models` (Google), Z.ai's models list. | OpenRouter: remaining credit as a `warn` when low. |
| **civo** | `GET api.civo.com/v2/quota` → account; confirms the key can read the account the sandboxes will bill. | Quota headroom for an instance of the configured size → `warn` when none. |
| **aws** | STS `GetCallerIdentity` → account and ARN (SigV4; `@aws-sdk/client-sts` if already a dependency, otherwise a minimal signer). | `ec2:DescribeInstances` dry-run → can it see EC2 in the configured region. |
| **tailscale** | An auth key cannot be introspected without using it (registering a device) or an admin API token Nexux does not have. So: format (`tskey-auth-…`) and, with a `loginServer`, that the server answers. `checks` says plainly that reusable / ephemeral / pre-authorized **cannot be verified** (`ok: null`). | — |

### Checks that depend on *where* it is used

A token being valid is half the answer; the other half is "for this repo".
Two contexts run extra checks with the same endpoint:

- **Git credential + a project** — for each of the project's repos with a
  URL on that credential's host: `GET /repos/{owner}/{repo}` (GitHub) or
  `GET /projects/:id` (GitLab) → `permissions.pull/push`. Offered in the
  project's sandbox settings next to the credential picker ("Check access to
  this project's repos").
- **Git credential + an image** — `assertImagePullable` (already written for
  Nexus hosts, spec 19/27) as a check line. Offered in the host form next to
  "Registry credential".

## UI

- Each credential row in Settings (Cloud, Git, AI Providers, Tailscale) gets
  a status dot from `lastCheck` and a **Test** button. The result expands
  under the row: identity, expiry ("expires in 12 days" as `warn` under 14),
  scopes as chips, and the `checks` lines with ✓ / ✗ / —.
- **On save**, the new credential is checked once and the result shown. A
  failure does **not** block saving — a self-hosted instance might be
  unreachable from here — but it is on screen before the user walks away.
- The obvious mistakes get named, not reported as "401": a value with
  whitespace or a newline, one that does not look like any token for that
  provider (length / prefix), a pasted shell command.

## API

`POST /api/credentials/[id]/check` → `CredentialCheck` (and stores it).
`POST /api/credentials/check` with an unsaved body → same result, stores
nothing — used by the create form before saving. Context variants:
`?projectId=…` and `?image=…` add the per-repo and image lines.

Checks live in `apps/web/src/lib/credential-checks/` — one module per
provider, each a pure function over an injected `fetch`, so every provider is
unit-tested against recorded responses without a network.

## Not in v1

- Scheduled re-checks / notifications before a token expires.
- Tailscale device-flag verification (needs an admin API token).
- Checking credentials on a *remote* Nexus host from here — each install
  tests its own.

## Order

1. ✅ `CredentialCheck` type, storage columns, `POST …/check`; GitHub (incl.
   the obvious-mistake detection) with tests; the Test button and status
   dot for git credentials.
2. ✅ GitLab, Bitbucket, Claude, LLM keys.
3. Civo, AWS, Tailscale.
4. Context checks: project repos, registry image; check-on-save.
5. ✅ Docker endpoints: can this machine host a sandbox (below).

## As built (phase 1)

- `apps/web/src/lib/credential-checks/`: `types.ts` (incl. `CHECKABLE_PROVIDERS`
  so the client knows where to offer Test), `shape.ts` (the obvious mistakes),
  `github.ts`, `index.ts` (dispatch; other providers return null → 422).
- A pasted shell command is refused **without sending it anywhere**; other
  shape problems (whitespace, unknown prefix) are shown and the check still
  runs.
- Missing `repo` warns (every sandbox needs it); missing `read:packages` or
  `workflow` shows ✗ on its line with why it would matter, and does not
  change the status.
- **Found on first real run:** of four saved GitHub tokens, three were
  rejected outright by GitHub. The Nexus host's registry check had reported
  them as "needs read:packages" — the pull would indeed fail, but for being
  invalid. Phase 4's image check should run this check first so the message
  names the real cause.
- A running dev server keeps its Prisma client in memory: after the
  migration it answered `Unknown argument lastCheck` until restarted.

## Phase 5 — can this Docker endpoint host a sandbox?

Spec 26 lets a local sandbox run on another machine's Docker. The endpoint
probe (reachable, not rootless) says the daemon answers; it cannot say the
sandbox will *work* there. The case that prompted this: on `omarchy`,
`daemon.json` pins container DNS to `172.17.0.1`, which only the default
bridge can reach — every container on a compose-style network has no DNS, so
a sandbox there could never clone, install or reach an API. Nothing said so.

**Test** on an endpoint row (Settings → Cloud → Docker endpoints) runs, with
throwaway `busybox` containers (`--rm`) on that daemon:

| Line | How | Why a sandbox needs it |
|---|---|---|
| daemon answers, not rootless | the existing probe | — |
| runs privileged containers | `run --privileged busybox true` | the sandbox is Docker-in-Docker |
| DNS on the default bridge | `nslookup github.com` | the sandbox container itself |
| DNS on a user-defined network | same, on a temporary `docker network create` | the sandbox's own stack services (compose), and Nexus hosts |
| reaches the internet | `nc -z github.com 443` | clone, install, APIs |
| disk space for Docker | `df` of `DockerRootDir`, mounted read-only | images and DinD storage — warn under 10 GB |

A failed DNS line says what to change (`dns` in `/etc/docker/daemon.json`,
naming what it is set to) — Nexux reports, the user changes their machine.
Everything it creates is removed, including the temporary network. The
result uses the same `CredentialCheck` shape and is stored on the endpoint
(`DockerEndpoint.lastCheck`).
