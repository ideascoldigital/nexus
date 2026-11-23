# 33 — Bots on the phone: a Flutter app for the simple view

Status: **design only**. No code written. Decided with the user on 2026-11-21:
scope is the bots view and nothing else, iOS + Android phones, over an
authenticated `/api/v1` surface.

## Goal

The bots view (spec 31) is the one surface in Nexus that is already shaped
like a messaging app: an inbox of teammates, a conversation, a bot that goes
off and does the work. That is also the surface you most want away from the
desk — a bot takes minutes to hours, asks a question halfway through, and
today the only way to answer is to walk back to the laptop.

So: a native phone app that is **the bots view, properly native**. Not a
dashboard in a WebView, not a second Nexus. The kanban, the stack canvas, the
sandbox wizard, the terminals and the project document stay on the desktop,
on purpose — they are built for a mouse and a wide screen, and a phone copy of
them would be worse at both.

Non-goals: projects, features, sandboxes, settings, hosts, imports, the global
assistant, the command palette. A link out to the desktop dashboard is the
whole of the app's relationship with the rest of Nexus.

## What the app is, in one screen list

| Screen | What it is |
|---|---|
| **Pair** | Connect to a Nexus host: scan a QR from Settings, or type URL + token |
| **Team** | The bot inbox: face, name, latest message, unread dot, Working… |
| **Chat** | One bot's conversation: bubbles, step chips, choices, mail cards, composer |
| **Bot sheet** | Activity (Now / Upcoming / Computer) and Settings, as a bottom sheet |
| **Computer** | The live screen, full-bleed; watch, take control, wake, sleep |
| **New bot** | Big face preview, name, 13 shapes, 11 colors |
| **Routine** | Name, prompt, frequency picker, enabled, Run now, delete |
| **Vault** | Logins / secrets / cards / contacts, behind biometrics |
| **App settings** | Hosts, notifications, about, disconnect |

Nine screens. Everything else is a sheet or a dialog on top of one of them.

---

## The blocker, first: the server is not reachable from a phone

Three things in today's server make a phone client impossible as it stands.
They are the real content of this spec; the UI is comparatively easy.

### 1. The REST API has no authentication

`/api/projects`, `/api/bots`, `/api/vault` — none of them check anything. The
dashboard is designed for `localhost` or a tailnet (see `SECURITY.md`), and
the browser is trusted because it is on the machine. A phone is not on the
machine. Shipping an app that pokes the open API over a tailnet means every
device on that tailnet, and every app on the phone that can reach it, has full
control of the install.

Only `/api/mcp` is gated, by `nxs_…` tokens with blast-radius scopes
(spec 21). That is the pattern to extend, not to work around.

### 2. The MCP surface does not cover bots

`/api/mcp` has ten tools, all about projects, tasks and sandboxes. There is no
`nexux_list_bots`, no feed, no prompt, no routines, no vault. Reusing MCP as
the transport would mean adding ten more tools shaped for an LLM — tool
descriptions, JSON-schema arguments, text results — to serve a client that
wants typed JSON and incremental reads. Wrong shape.

### 3. The bot's screen is on loopback

`botVncUrl()` (`packages/sandbox/src/bot.ts:942`) builds
`http://127.0.0.1:<port>/…`. The noVNC port is published **on host loopback
only**, deliberately: an unauthenticated VNC on a tailnet interface is a
remote desktop for the whole tailnet. Spec 31 already lists this as a known
limit — "from a remote Nexus host over Tailscale the chat works but the screen
does not — that needs a WS proxy through the terminal server, left for a
follow-up". The phone app is that follow-up's forcing function: watching the
bot work is the single most valuable thing the app does.

---

## Server work: `/api/v1`

A small, typed, token-gated HTTP surface next to the existing one. Not a
rewrite — every route is a thin wrapper that calls the same functions the
dashboard routes already call (`enqueueBotPrompt`, `startBotSession`,
`shapeRun`, `toPublicItem`, …), so there is no second implementation of
anything and no behaviour can drift.

```
apps/web/src/app/api/v1/
  _auth.ts                     # bearer token → scopes, 401 with no body
  ping/route.ts
  events/route.ts              # SSE
  bots/route.ts
  bots/[botId]/route.ts
  bots/[botId]/feed/route.ts
  bots/[botId]/runs/route.ts
  bots/[botId]/runs/[runId]/route.ts
  bots/[botId]/runs/[runId]/mail/route.ts
  bots/[botId]/session/route.ts
  bots/[botId]/routines/…
  bots/[botId]/files/[runId]/[name]/route.ts
  bots/[botId]/screen/[[...path]]/route.ts    # the proxy
  vault/route.ts
  vault/[itemId]/route.ts
```

### Auth

Reuses `lib/api-token.ts` (sha-256 hash, `timingSafeEqual`, `lastUsedAt`,
revocation as a timestamp) and `lib/api-scopes.ts`. New scopes, following the
existing blast-radius logic — the separable thing here is not money, it is
**secrets** and **remote control of a desktop**:

| Scope | Allows |
|---|---|
| `bots:read` | list bots, read a feed, read routines, download a bot's files |
| `bots:write` | send prompts, cancel runs, create/edit/delete bots and routines, wake/sleep a computer, act on mail cards |
| `bots:screen` | the screen proxy — watching and driving the bot's desktop |
| `vault:read` | the public part of vault items (never a secret) |
| `vault:write` | create, edit, delete vault items |

`vault:read` is separate from `bots:read` because a vault listing is a map of
which accounts exist; `bots:screen` is separate from `bots:write` because a
token that can ask a bot for something is not automatically a token that can
drive a signed-in browser. A token minted for the phone normally carries
`bots:read`, `bots:write`, `bots:screen` and, if the user wants the Vault
screen, `vault:*`.

Mutating routes additionally honour an `Idempotency-Key` header, kept for an
hour: a phone on a flaky connection retries, and `POST …/runs` must not queue
the same prompt twice.

### Pairing

Settings → API tokens gets a **Pair a phone** action. It mints a token with
the bot scopes and shows a QR of:

```
nexus://pair?host=https%3A%2F%2Fstudio.tailnet.ts.net%3A3030&token=nxs_…&name=Studio
```

The QR is shown once, like the token itself, and is valid to scan for ten
minutes (the token keeps working; the QR just stops being displayed). The app
then calls `GET /api/v1/ping`:

```json
{ "ok": true, "host": "Studio", "version": "0.1.8", "commit": "a3f91c2",
  "scopes": ["bots:read","bots:write","bots:screen","vault:read","vault:write"],
  "apiVersion": 1, "capabilities": ["sse","screen-proxy","screen-frame"] }
```

`capabilities` is what lets one app version talk to older hosts: no
`screen-proxy` on the host means the Computer screen explains that this host
is too old instead of showing a broken frame. The app stores host + token in
the platform keystore (iOS Keychain / Android Keystore), never in shared
prefs, and supports several hosts with a switcher — a laptop and a 24/7 host
is the normal setup.

Manual entry (URL + pasted token) exists for anyone who cannot point a camera
at their own screen.

### Reads: feed with a cursor

`GET /api/v1/bots/:id/feed` returns the same shape as today's
`/api/bots/:id/runs` (`bot`, `session`, `runs`, `routines`, `threads`) plus
two things a phone needs:

- `?before=<runId>&limit=50` — the chat loads the last 50 and pages back. The
  current route returns a fixed last-100 every time; on a phone that is a
  wasteful payload and still not enough history.
- `?since=<iso>` — only runs created or updated since then, plus a
  `cursor`. A reconnecting app asks for what it missed, not for everything.

### Live updates: SSE, not polling

The web view polls `/api/bots` every 4 s and a feed every 1.5 s while a run is
live. On a phone that is a battery and data decision, so:

`GET /api/v1/events?bots=<id>,<id>` — `text/event-stream`, heartbeat comment
every 25 s, `Last-Event-ID` for resume. Events:

```
event: bot            data: {"id":"…","activity":"working","preview":"…","needsInput":false}
event: run            data: {"botId":"…","run":{…shapeRun…}}
event: step           data: {"botId":"…","runId":"…","step":{"app":"Browser","action":"Opened","detail":"https://…"}}
event: session        data: {"botId":"…","session":{…shapeSession…}}
event: routine        data: {"botId":"…","routine":{…}}
```

Server side this is a subscription on the same places that already write these
rows (`bot-manager`'s drain loop, `fireDueRoutines`, the session boot), so
nothing new is computed — it is a fan-out of writes that already happen. The
app keeps polling as a fallback when SSE cannot connect (every 10 s
foreground, never in background).

### The screen proxy

`GET /api/v1/bots/:id/screen/*` — an authenticated reverse proxy, in the web
app, to that bot's live session on `127.0.0.1:<vncPort>`. It serves the
container's own noVNC page and upgrades `/websockify` to the WebSocket
websockify is already speaking. Rules:

- Requires `bots:screen`, and the session must be `ready`. A proxy that
  outlives the session is a hole that stays open.
- The WebSocket cannot carry an `Authorization` header from a WebView, so the
  app first calls `POST /api/v1/bots/:id/screen/ticket` → `{ "url":
  "https://host/api/v1/bots/:id/screen/?t=<opaque>", "expiresAt": … }`. The
  ticket is single-use, 60 s to redeem, bound to the bot, the session and the
  token's scopes — the same shape as the vault run token
  (`lib/bot-vault-access.ts`), for the same reason.
- `?viewOnly=1` is enforced **server-side** on a view-only ticket: the proxy
  drops client→server RFB pointer and key messages. View-only as a
  `postMessage` to an iframe (what the dashboard does) is a UI convention; on
  a phone, with a ticket URL that could be reused, it has to be a property of
  the connection.
- Each redeemed ticket counts as activity (`lastActivityAt`), so the idle
  reaper does not delete a computer you are watching from the sofa. The app
  also sends `PATCH …/session` every 60 s while the screen is open, exactly as
  the dashboard's heartbeat does.

And one cheap addition that pays for itself everywhere:

`GET /api/v1/bots/:id/screen/frame.jpg?w=320` — one JPEG of the current
screen, from the container's own X display. The inbox and the Computer card
want a thumbnail, and a WebView per row to get one is absurd. Implementation
is a `docker exec` screenshot, cached ~2 s per bot.

---

## The app

### Stack

| Concern | Choice | Why |
|---|---|---|
| Language | Dart 3 / Flutter stable | the ask |
| State | Riverpod + freezed | the data is streams of server state; codegen keeps the API models honest |
| Routing | go_router | deep links (`nexus://pair`, a notification opening one bot) |
| HTTP | dio + retrofit-style generated client | interceptors for the bearer token, retries, `Idempotency-Key` |
| SSE | `http` long-lived response, parsed in Dart | no package worth the dependency |
| Secrets | flutter_secure_storage + local_auth | token in the Keychain/Keystore; biometrics gate the Vault screen |
| Screen | webview_flutter (+ the proxy's noVNC page) | noVNC already solves RFB, scaling and touch. A Dart RFB client is a month of work to be worse |
| Markdown | flutter_markdown (hardened) | bot replies are markdown, with images that are app-authenticated URLs |
| Notifications | flutter_local_notifications | see below |
| Bot faces | **custom painter, ported from `lib/bot-shapes.ts`** | the faces are generated geometry, not assets; porting the superformula math keeps one source of truth for what a bot looks like |

Feature-first layout:

```
lib/
  core/        theme/ (graphite tokens), api/ (client, sse, errors), storage/
  features/
    pairing/   team/   chat/   bot/   computer/   routines/   vault/   settings/
  shared/      bot_avatar.dart (the painter), markdown/, widgets/
```

### Design language

The bots view has its **own** theme — `.dark:has(.bots-ui)` in `globals.css`:
neutral graphite, not the Nexus Void blues, because the bot's own color is the
only accent in the view. The app inherits exactly that. Tokens, converted from
oklch:

| Token | Hex | Used for |
|---|---|---|
| background | `#101010` | app background |
| sidebar | `#171717` | inbox background, app bars |
| popover | `#191919` | sheets, dialogs |
| card | `#1e1e1e` | bot bubbles, cards |
| muted | `#232323` | thumbnails, inert fills |
| secondary | `#242424` | secondary buttons |
| accent | `#262626` | selected row, pressed state |
| border | `#2b2b2b` | hairlines |
| input | `#303030` | field borders, off switch |
| muted-foreground | `#989898` | secondary text, timestamps |
| foreground | `#f2f2f2` | text |
| destructive | `#c25d58` | errors, delete |

State colors, as the web uses them: working / awake `#38bdf8` (sky 400), in
control `#fbbf24` (amber 400), the NEW divider `#fb7185` (rose 400), unread
dot `#0ea5e9` (sky 500). Eyes `#18181b`.

The bot's 11 colors and 13 shapes are the identity system and carry over
unchanged: `#f4f4f5 #a16a3e #ef4444 #f2602a #f59e0b #22c55e #14b8a6 #3b82f6
#8b5cf6 #ec4899 #71717a`, and `blob circle squircle tilted flower cloud star
gear egg pill triangle hexagon diamond`. `textOn()` (WCAG luminance,
threshold 0.4) decides black or white text on a bot-colored bubble — port it,
don't eyeball it.

Type: **the platform's own face** — SF Pro on iOS, Roboto on Android, which is
what Flutter reaches for by default. The web uses Inter; the app deliberately
does not. Three reasons, in order of weight: the system face is hinted and
spaced by the vendor for that exact screen, it is the only option that honours
the text size the user set in Accessibility without us implementing anything,
and it ships nothing — no download, no flash of unstyled text on a cold start.
The cost is that app and web are not glyph-identical, which nobody will notice
and which matters less than a screen that is read standing up.

JetBrains Mono stays for anything mechanical (cron strings, MCP JSON, scopes,
log tails) — it already separates `0`/`O` and `l`/`1`, and sharing it with the
web is worth the one font we do bundle.

Sizes step up a notch from the web's density, which was drawn for a monitor at
60 cm:

| Where | Web | App |
|---|---|---|
| bot name in the inbox | 15 regular | **16 medium** |
| preview line | 12.5 | **13.5**, lightened to `#a8a8a8` |
| chat bubble | 14.5 | **16** |
| mail body, teammate posts | 13.5 | **15** |
| form fields, option cards | 14 | **15** |
| captions, timestamps | 11.5 | **12.5** |

That is the body size of WhatsApp and Mail. It costs one bot per inbox screen
(seven instead of eight), which is not a loss in a list that has search.

If the system face is ever dropped for a bundled one, the text-scale work
becomes ours: `MediaQuery.textScaler` has to be honoured explicitly and the two
fixed-height pieces — the inbox row and the remote desktop's key bar — are what
will break first.

### Team (inbox)

The web's left rail, full-screen. An app bar with the title, search, a shield
(Vault) and `+`; rows of 38px faces with name, preview line and an unread dot.

- The preview line is the server's `preview`; while the bot is busy it is
  replaced by **Waking up…** or **Working…** in sky, as the web does.
- A face whose computer is off has closed eyes (`sleeping`). Faces lean and
  glance aside at rest and turn to face you when selected — the web does this
  in CSS; in Flutter it is an `AnimationController` with the same spring
  (`cubic-bezier(0.34, 1.56, 0.64, 1)`, 520 ms).
- Unread is per-device (`nexux:bots-seen` in the web; shared prefs here), a
  convenience, never a server concept. A bot whose last reply `needsInput`
  always shows the dot.
- Long-press a row: mark read, wake/sleep the computer, delete.
- Pull to refresh; SSE keeps it live otherwise.
- Empty: the pink blob at 84px, "Meet your first bot", one button.

### Chat

The screen the app exists for. Everything the web renders, rendered natively:

- Your messages right, in the bot's color, text per `textOn()`. The bot's
  left, in `card`. Markdown in bot replies.
- Centred timestamps after a 30-minute gap (`Today 3:42 PM`).
- `New computer · fresh memory` between sessions; a rose `NEW` divider at the
  first reply you had not seen, frozen on open so it does not move as you read.
- While a run is live: a typing bubble (three bouncing dots) whose label is
  the **latest step**, replaced in place — `Browser · Opened ·
  https://vendor.example` — with `Watch` and `Stop`. Step icons by app
  (Browser/Web → globe, Search, Terminal, Files, else wrench).
- Queued prompts show `Queued · Cancel`.
- **Choices card**: the question, then lettered options and `Something else`
  (which focuses the composer). Picking one sends its text; the card then
  shows the pick in a tile of the bot's color and the answer gets no bubble.
- **Mail card**: `Mail · subject`, From / To / Cc, the body, editable in
  place, `Discard` and `Send` with `Save as draft in Gmail` in its menu. After
  acting it is read-only and follows the sending run (Sending… → Sent / Saved
  to Drafts). A card acts once.
- **Needs input**: the bot's text plus a pill — `Take control of the
  computer` — which opens the Computer screen with a control ticket.
- **Teammate posts**: the sender's face, name, `@Bot message`, and the
  teammate's reply threaded under it, tappable to open that bot.
- System lines, centred, no bubble: `You gave Ada its computer back`,
  `Routine ⏱ Morning digest`, `✉ You sent "Quote request"`, `↳ Continuing
  with Ada's answer`, `Updated routine ⏱ …`.
- Images in a reply render as a thumbnail row and open as a carousel
  (swipe, dots). Files are a row with name, size and a share sheet. Both come
  from `…/files/:runId/:name` with the bearer token.
- Composer: a pill that grows to five lines, send button a circle in the bot's
  color. Placeholder `Message Ada`, or `Ada is busy. This will run next…`.
  Enter inserts a newline on a phone; the button sends.
- Phone-only: long-press a bubble to copy or share, swipe-back to the inbox,
  the composer sits above the keyboard, and a jump-to-latest button appears
  when you scroll up.

Paging: the last 50 runs, more on scroll-to-top. Optimistic send — the bubble
appears immediately, marked pending until the `run` event confirms it.

### Bot sheet

The web's right panel, as a draggable bottom sheet at 92% height, opened by
tapping the name pill. Big face (sleeping when the computer is off), name,
role, and two pill tabs:

**Activity** — `Now` (the running prompt, `Working · N steps so far`, or
`Nothing in progress`, plus `N more queued`); `Upcoming` (routines with the
schedule in words and a switch in the bot's color, tap to edit, or `Suggested
· Create a routine` when there are none); `Computer` (state label and a live
thumbnail from `frame.jpg`, tap to open).

**Settings** — name, job, standing instructions, Tools (MCP servers) as a
monospace JSON field with the same validation (`lib/bot-mcp.ts` rules ported:
name pattern, `browser` reserved, stdio needs `command`, http/sse need `url`,
a pasted `{"mcpServers":…}` unwrapped) and the same warning about
`{{secret:name}}`, Look (13 shapes, 11 colors), Model, Sleep after, and
`Delete bot` behind a confirm that says its computer and chat go with it.

### Computer

Full-bleed, landscape-aware, the one screen that leaves the chat.

- Top bar: face, `Ada's computer`, and the state — `Asleep` / `Waking up…` /
  `Awake` / `Working` / `Could not start`, or `You're in control` in amber.
- The screen in 16:10, letterboxed on black. Rotating the phone fills the
  width; pinch-zoom and pan when in control (the panel is 1440×900 — a phone
  screen is not going to show a Chromium window legibly otherwise).
- `Take control` / `Give back control`. Taking control asks for a control
  ticket; an amber ring marks it, as the web does. Giving it back — the
  button, or leaving the screen while driving — closes the screen and, if the
  bot is idle, sends `HANDBACK_PROMPT` so it looks at what you did and carries
  on. If it is already working, nothing is sent; it sees the screen anyway.
- `Wake up` when asleep; `Put to sleep` behind a confirm, because it deletes
  the computer.
- Driving from a phone needs what a keyboard gave you: a key bar above the
  screen (Esc · Tab · ⌃ · ⌥ · ⌘ · ↑↓←→ · Enter), a text field that types a
  string into the remote (so a password manager and dictation both work), and
  `Paste` / `Copy "…"` for the remote clipboard, which the noVNC page already
  bridges by `postMessage`.
- Asleep: sleeping face and the honest line — it wakes by itself when you send
  a message, and is deleted after N idle minutes. Waking: spinner plus the
  boot `progress` string, and the warning that the first boot builds the image
  and can take 10–20 minutes.
- Heartbeat every 60 s while open.

### New bot

Full-screen modal: the face at 108px, a centred `Name your Bot`, the 13 shapes
as a wrapped grid of 40px faces, the 11 colors as dots, Cancel / Create. Job
and instructions are edited later, from the sheet — same as the web.

On create the bot greets you first (the intro run), so the app lands in its
chat with a typing bubble already going. That is the best first-run moment the
product has and the app should not skip it.

### Routine editor

A sheet: name, prompt, a frequency picker (`Every day`, `Every weekday`,
`Every week`, `Every month`, `Every hour`, `Custom (cron)`), the time in a
native picker, and the resulting schedule in words — `Every Monday around
8:00 AM` — from the server's `label`, never computed on the phone. Plus an
enabled switch in the bot's color, `Run now`, and delete.

Cron is the host's timezone, not the phone's. The sheet says which, because a
routine set from a different timezone is the kind of bug nobody finds for a
week.

### Vault

Behind `local_auth` (Face ID / fingerprint, device passcode fallback) every
time it is opened, not once per session. Segments for Logins / Secrets / Cards
/ Contacts; rows show the public part only — name, `Visa •••• 4242`, website
chips, hint, which bots may use it, `used 2d ago`.

Add and edit show secret fields as write-only: a field that already holds a
value says so (`•••• stored`) and typing replaces it. The API never returns a
secret and neither does the app's cache — and nothing from the Vault screen is
written to disk.

### Notifications — and what the app cannot honestly promise

A bot asking a question is exactly what you want to be told about, and this is
where local-first bites. There is no Nexus cloud, so there is no APNs/FCM
sender. Three options were weighed:

1. **A relay** — a tiny hosted service the host pushes to and the phone
   subscribes to. Real push, real background delivery, and a cloud dependency
   plus bot-reply metadata leaving the machine. Against the product's
   premise.
2. **Local notifications on a live connection.** While the app runs (and, on
   Android, a foreground service can keep it running), the SSE stream turns
   `needsInput` and finished runs into local notifications. Android: good. iOS:
   dies minutes after backgrounding, and that is not negotiable from the app
   side.
3. **Nothing in-app; Telegram and Slack already do this.** The notification
   hub (spec 31's siblings) already sends run results, screenshots and
   reply-to-continue to a phone, today, with real push.

The design: **(2) for in-app and Android, and point at (3) in the UI** — the
app's notification settings say plainly that out-of-app alerts come from
Telegram or Slack, with a link to how to set it up, instead of implying
background push it cannot deliver. A relay stays an explicit, opt-in,
later decision; if it is ever built it slots behind the same settings screen.

### Offline and failure

The phone is on a tailnet that comes and goes. So: feeds, bot lists and read
vault items are cached (sqlite via drift, or hive — decide at build time); the
cache renders immediately with a `Last updated …` line; writes queue with
their `Idempotency-Key` and flush on reconnect, except prompts, which show as
`Not sent · Retry` rather than firing an hour later into a conversation that
has moved on. A 401 means the token was revoked: back to Pair, cache cleared.
`capabilities` drives graceful degradation per host.

---

## Delivery phases

1. **Server: `/api/v1` reads.** `_auth.ts`, the new scopes, `ping`, `bots`,
   `bots/:id/feed` (with `before`/`since`), `files`, `vault` read. Pair-a-phone
   QR in Settings. Testable with curl before any Dart exists.
2. **Server: writes.** prompts, cancel, bot CRUD, session start/stop/touch,
   routines, mail actions, vault writes, `Idempotency-Key`.
3. **Server: live + screen.** SSE `events`, the screen proxy with tickets and
   server-enforced view-only, `frame.jpg`.
4. **App: shell.** Pairing, graphite theme, the bot-shape painter, Team inbox
   with polling.
5. **App: chat.** Bubbles, steps, timestamps, session dividers, composer,
   choices, system lines, images. The bulk of the work.
6. **App: bot sheet + new bot + routines.**
7. **App: computer.** WebView on the proxy, control tickets, the key bar,
   clipboard, heartbeat, hand-back.
8. **App: mail cards, vault with biometrics, notifications, offline cache.**
9. **Ship.** Icons from the Nexus mark, TestFlight / internal track.

Phases 1–3 are the real prerequisite: each one is useful on its own (an
authenticated bots API is worth having regardless of this app), and nothing in
4–9 can start without 1.

## Open questions

- **Does the phone token see the Vault at all?** Default yes, user's call at
  pairing time. A phone is lost more often than a laptop, and `vault:*` on it
  means a stolen unlocked phone can enumerate accounts. The biometric gate is
  the mitigation; a "pair without Vault" option at mint time is the better one.
- **One host or many, in the first cut?** Many is the honest setup (laptop +
  24/7 host) and the switcher is cheap, but every screen then has a "which
  host" question. Leaning: store many, show one, switch from app settings.
- **`frame.jpg` on the inbox** is a `docker exec` per bot per refresh. Fine
  for five bots, not for fifty. Cap it: thumbnails only for awake bots, only
  on the Computer card and the visible rows.
- **iPad / tablet** was explicitly out of scope today. The two-pane layout is
  a later, additive change (inbox + chat side by side) and the design above
  does not block it.
- **Does the app replace the Tauri shell on desktop?** Not in this spec. If
  Flutter desktop ever makes sense, it is for this view only, and the Tauri
  app still carries the dashboard.
