# Spec 35 — Connect Apps

**Status:** shipped (v1) · 2026-11-22 · see D-92

## Problem

Bots reach most services through their browser, and browser sign-ins do not
last: each wake-up is a new machine to the service, and Google in particular
signs it out (spec 34). For anything with an API there is a sturdier path —
the service's MCP server with a token — but setting one up meant writing MCP
JSON per bot and a `{{secret:…}}` in the vault.

## What it is

A catalog of apps (`lib/connectors.ts`), connected once from **Connect apps**
(the blocks button in the bots view, or Settings → Connect apps):

| Kind | Apps |
|---|---|
| Built into Nexus | Gmail (spec 34), Google Calendar (spec 36) |
| MCP in the bot's computer (`npx`) | Slack, Notion, Airtable, MongoDB, PostgreSQL, Supabase, HubSpot, Brave Search |
| Remote MCP over HTTP with a token | GitHub, Stripe |

Each entry has the steps to get its token (with links), its fields (a secret,
plain text, or a toggle such as **Read only**, on by default for databases and
GitHub), and which bots may use it (all by default, like the vault).

## How it works

- `Connector` row per connected app, id = catalog id; `config` (what was typed,
  tokens included) is sealed by the vault extension. The browser only learns
  plain values and *which* secrets are set; an empty secret on save keeps the
  stored one.
- On every prompt the bot manager adds `connectorServersFor(botId)` to the
  bot's MCP servers. The bot's own server of the same name wins. The system
  prompt already tells it to prefer an MCP server over clicking through the site.
- Unlike Gmail (spec 34), where the token never leaves Nexus, an MCP
  connector's token is in the bot's computer while it works (the server's env
  or headers). A bot could read it, so the UI asks for read-only, narrowly
  scoped tokens and limits each app to the bots chosen for it.
- Disconnect deletes the row; bots lose the app on their next message.

## Not in v1

- Apps whose MCP needs OAuth (Vercel, Linear, Cloudflare, Figma, Google Drive):
  an MCP OAuth client in Nexus, or more scopes on the Google app (as Calendar
  did, spec 36).
- Checking a token works before saving (each app has its own "who am I").
- The Mac's own apps (Messages, Notes, …): bots run in Linux computers.
