# 32 — Vault: secrets encrypted at rest, usable by bots without being read

## Goal

Two problems, one fix:

1. **Nothing is encrypted today.** `CloudCredential.data`, `ProjectEnvVar.value`,
   `Settings.value` and `OAuthToken` sit in the SQLite file as plaintext
   (`ENCRYPTION_KEY` is read and never used — see `lib/export/envelope.ts`).
   Anyone with a copy of `dashboard.db` (a backup, a synced folder) has every key.
2. **Bots need credentials without seeing them.** An MCP server needs an API
   key or a connection string; a bot signing into a site needs a password.
   Pasting them into a bot's settings JSON leaves them in plain JSON, and
   handing them to Claude puts them in its context and in the run log.

The vault is the place secrets live, encrypted, and the only path by which a
bot gets to use one.

## Threat model

Protects against: a copy of the database file leaving the machine (backups,
Time Machine, sync, a support bundle); secrets showing up in the UI, the API,
logs, run transcripts or Claude's context.

Does **not** protect against: code running as the user on this machine while
Nexus runs (it can ask the Keychain like Nexus does); a bot's computer, which
holds the secrets its MCP servers need, in a file only it can read — a bot
that can use a key can, in principle, exfiltrate it. Mitigation is least
privilege: read-only database users, scoped API keys, per-entry bot access.

## Encryption at rest (`@nexux/db` `vault.ts`)

- **Cipher:** AES-256-GCM (`node:crypto`), random 12-byte IV per value. Sealed
  text: `nxv1:<base64 iv|tag|ciphertext>`; a sealed Json column stores
  `{"$nxv": "nxv1:…"}`. GCM fails loudly on a wrong key instead of returning
  garbage.
- **Key** (32 random bytes), resolved in order:
  1. `NEXUX_VAULT_KEY` (base64) — servers, CI, explicit setups.
  2. A database under the OS temp dir (tests) → a per-process ephemeral key.
  3. macOS → the login **Keychain**, generic password `nexux-vault` /
     `master-key`, via `/usr/bin/security`. Created on first use.
  4. Elsewhere (a Nexus host on Linux) → `vault.key` (0600) next to the
     database, or `NEXUX_VAULT_KEY_FILE`.
- **Key check:** `Settings["vault_key_check"]` holds an HMAC of a fixed label
  under the key. At boot, a mismatch means the key changed or was lost: Nexus
  refuses to start sealing with a new key over data sealed with the old one,
  and says so, rather than silently making everything unreadable.
- **Transparent in the client:** a Prisma extension seals on write
  (create / update / upsert / createMany / updateMany) and opens on read —
  result extensions apply inside `include` and `select`, so the ~17 call sites
  that read credentials don't change. Plaintext reads through unchanged, which
  is what makes the migration incremental.
- **Sealed fields:** `CloudCredential.data`, `ProjectEnvVar.value`,
  `Settings.value` (except `vault_*` bookkeeping), `OAuthToken.accessToken` /
  `refreshToken`, `SandboxConfig.mcpServers`, `Bot.mcpServers`, and
  `VaultItem.secret`. Nested writes that bypass the model extension (the
  GitLab / ClickUp `oauthTokens: { create }`) seal explicitly.
- **Migration:** at boot, `sealPlaintext()` rewrites any row still in
  plaintext, in one transaction per table. Idempotent; a fresh install has
  nothing to do. A backup of the database is the operator's step before the
  first boot (done for the dev DB on 2026-11-19).

## Vault items (`VaultItem`)

What the user keeps for bots, in Settings → Vault and the bots view:

| type | public (listed) | secret (sealed) | used by |
|---|---|---|---|
| `login` | websites, username, hint | password | bots signing in |
| `secret` | name, hint | value | MCP servers: `{{secret:name}}` |
| `card` | name, brand, last 4, hint | number, expiry, cvc, name on card | bots paying |
| `contact` | name, hint | email, phone, address | bots filling forms |

- The API never returns `secret`. The list and the edit dialog show the public
  part; a secret field can be replaced, never read back.
- `botIds` — which bots may use the entry; empty means every bot.
- `name` is unique per type (a `secret` is referenced by it).

## How a bot uses an entry without reading it

- **MCP servers:** a bot's (and later a project's) `mcpServers` may contain
  `{{secret:<name>}}` in any string (`env`, `headers`, `args`, `url`). The
  bot manager resolves it at the moment it writes the config into the computer
  (stdin → 0600 file, spec 31). Unknown or forbidden names drop that server
  and the bot is told which.
- **Logins, cards, contact:** a `vault` MCP server (a small Node script, written
  into the computer with the config) offers `vault_list` (public parts only)
  and `vault_fill({entry, field})`. `vault_fill` asks Nexus — with a token
  valid only while that run runs — to type the value into the focused field of
  the visible Chromium (CDP `Input.insertText` via `docker exec`, value on
  stdin). Claude never sees the value, and neither does the run log. Guards:
  a password only goes into an `<input type=password>`; a login's fields only
  on a page whose host matches one of its websites; a card's only on https.

## Out of scope (v1)

Import from browsers / password managers; key rotation; sharing secrets with
project sandboxes' `mcpServers` (the resolver is shared, the UI isn't);
a passphrase-unlocked mode.
