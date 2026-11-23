# 36 — Google Calendar connector: bots read and schedule through Nexus

**Status:** shipped (v1) · 2026-11-23 · see D-95

## Goal

Bots that organise work (an assistant, a recruiter, a sales bot) need the
user's agenda: what is on today, when there is a free hour, and to put the
meeting there. Through the browser that means Google Calendar's UI and a Google
sign-in that does not last (spec 34). Like Gmail, Calendar goes through the API
instead: the user connects once, Nexus keeps the token, the bot asks Nexus.

## Shape

- **Same Google app, same account, more scopes.** No second OAuth client and no
  second account row: an account connected for Gmail adds Calendar with one more
  consent (`include_granted_scopes=true`, so the new token carries both), and an
  account can be Calendar-only. Which apps an account has is read off its
  token's granted scopes (`grantedApps`) — no schema change. Connections ask for
  `apps` (`POST /api/google/oauth/start {apps: ["calendar"], loginHint}`); the
  state remembers them, and the callback refuses a consent where any of the
  asked-for app's scopes was unticked.
- **Scopes.** `calendar.events` (read and write events on every calendar the
  user has) + `calendar.readonly` (the calendar list and free/busy). No calendar
  settings, sharing, or deleting calendars themselves.
- **What bots may do** (the user chose read and write): read the agenda, look
  up free/busy (theirs, or colleagues' as far as those share it), create, move
  and cancel events, add a Meet link. Guests: putting someone in `attendees`
  adds the event to their calendar; emailing them (`notify: true` →
  `sendUpdates=all`) happens only when the user asked for invitations, and the
  default is `sendUpdates=none`. The system prompt says so, and also: check the
  slot before scheduling, and say exactly what went on the calendar.
- **Times.** A time without an offset (`2026-11-24T10:00`) is a wall-clock time
  in the user's zone (the host's, as for routines) or the `timeZone` given; with
  an offset it is an exact instant; a bare date is an all-day event whose end
  defaults to the next day. Reading windows (`timeMin`/`timeMax`) need an
  offset. `buildEvent` refuses an end before the start, mixed date/date-time,
  unknown zones, and a move that gives only one end (`partial` updates send only
  the fields given).
- **Bots.** A `calendar` MCP server in the computer (`@nexux/sandbox`
  `bot-calendar.ts`, dependency-free, written in with each prompt) with
  `calendar_accounts`, `_calendars`, `_events`, `_get_event`, `_freebusy`,
  `_create_event`, `_update_event`, `_delete_event`. It holds only the prompt's
  token and relays to `POST /api/bots/:id/calendar`, which picks the account (the
  one named, or the bot's only Calendar account) and calls the API with the
  sealed token. `calendar` is a reserved MCP name. Every change is logged with
  the bot's name.
- **Who may use an account.** The account's bot list (spec 34) covers both apps.

## Where

- `apps/web/src/lib/gmail.ts` — `APP_SCOPES`, `scopesFor`, `grantedApps`, `parseApps`.
- `apps/web/src/lib/google-calendar.ts` — pure: event builder and validation, event summaries.
- `apps/web/src/services/google-calendar.ts` — Calendar API calls on the account's token.
- `apps/web/src/app/api/bots/[botId]/calendar/route.ts` — the relay.
- `apps/web/src/components/vault/google-accounts.tsx` — one component for both
  apps (Connect apps → Gmail / Google Calendar): connect, "Add Calendar" on a
  Gmail account, bot access, disconnect (revokes the whole account at Google).

## Setup note

An OAuth app made for Gmail needs the **Google Calendar API** enabled in its
Cloud project too; the Calendar page says so with a link. Until then Google
answers Calendar calls with an "API not enabled" error, which the bot relays.

## Not done

- Reminders, recurrence rules on create, colours, working hours.
- Responding to invitations (accept/decline) as the user.
- Drive: same app and consent, more scopes — next.
