# 34 — Gmail connector: bots use Gmail through Nexus, without signing in

## Goal

Bots that work with email (Isa, Simplifybot customer experience…) kept asking
the user to sign into Gmail. Each bot's browser profile does persist
(`~/.nexux/bot-profiles/<botId>`), and team cookie sharing never touches
Google — yet the Gmail bots' profiles had no Google session left, while a bot
that only browses Google kept its own. Google signs the session out: a fresh
Linux Chromium on a new machine every time the computer wakes looks like a
stolen session to it.

The connector takes Gmail out of the browser. The user connects an account
once; Nexus keeps the token; the bot asks Nexus.

## Shape

- **The user's own OAuth app.** A *Desktop app* client in the user's Google
  Cloud project, with audience *Internal* on a Workspace account: no review by
  Google, refresh tokens that do not expire after 7 days (they do for an
  external app in "testing"), and loopback redirects on any port, which a
  sidecar on an ephemeral port needs. A shared Nexus app would need Google's
  restricted-scope verification (a security assessment) — a SaaS concern, not
  now. The id/secret live in `Settings` (`google_client_id`/`_secret`, sealed).
- **Consent in the user's browser.** `POST /api/google/oauth/start` returns the
  URL (PKCE S256, `access_type=offline`, `prompt=consent`); the app opens it
  with `openExternal`, because Google refuses sign-in inside an embedded
  WebView. `GET /api/google/oauth/callback` exchanges the code, checks every
  Gmail scope was granted (the consent screen lets the user untick them), reads
  the address, and answers with a small "you can close this tab" page. The app
  polls the account list while it waits.
- **Storage.** One `ConnectedAccount` per address (`providerType: "google"`,
  `metadata: { email, botIds }`) with one `OAuthToken`, both tokens sealed by
  the vault extension (spec 32). Reconnecting an address replaces its token and
  keeps who may use it. `invalid_grant` on refresh marks it `expired`.
- **Scopes.** `gmail.readonly` + `gmail.compose` (drafts and send). No
  `gmail.modify`: no labels, archive or delete.
- **Bots.** A `gmail` MCP server inside the computer (`@nexux/sandbox`
  `bot-gmail.ts`, dependency-free, written in with each prompt) with
  `gmail_accounts`, `gmail_search`, `gmail_read`, `gmail_draft`, `gmail_send`.
  It holds no Google token, only the prompt's token (the vault's per-run grant,
  `lib/bot-vault-access.ts`), and relays to `POST /api/bots/:id/gmail`, which
  picks the account (the one named, or the bot's only one), refreshes the token
  and calls the Gmail API. `gmail` is a reserved MCP name.
- **Who may use an account.** Like vault entries: no list means every bot.
- **Sending.** The user chose that bots may send. The system prompt limits
  `gmail_send` to emails the user asked to have sent — in the conversation or
  in a routine's instructions — and keeps the email card as the way to review.
- **Email cards.** When the card's From is a connected account the bot may use
  (or the bot has exactly one), Send / Save as draft go straight through the
  API from Nexus — no bot run, done in a second. The card is claimed before the
  call (a double click cannot send twice) and given back if the call fails. Its
  state is `delivered`, with the email as it went out. A `threadId` on the
  block makes it a reply in the same conversation, with `In-Reply-To` /
  `References` taken from the thread.

## Where

- `apps/web/src/lib/gmail.ts` — pure: consent URL, PKCE, RFC 2822 builder
  (RFC 2047 subjects, no header injection), message reading, account access.
- `apps/web/src/services/google.ts` — app settings, state, exchange, refresh,
  accounts, Gmail calls.
- `apps/web/src/app/api/google/*`, `app/api/bots/[botId]/gmail`, the mail card
  route.
- `apps/web/src/components/vault/gmail-accounts.tsx` — top of the Vault (Settings
  → Vault and the bots view): app setup with a step-by-step guide, Connect,
  accounts with bot access and Disconnect (revokes at Google).

## Not done

- Drive: same app and consent, more scopes — next. (Calendar shipped this way: spec 36.)
- Attachments: listed when reading, not downloadable or sendable yet.
- HTML email: bots send plain text.
- The browser's Google sign-in problem itself (a per-bot stable machine
  identity) — the connector sidesteps it for Gmail only.
