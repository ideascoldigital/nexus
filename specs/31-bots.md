# 31 — Bots: AI teammates with their own ephemeral computer

## Goal

A simple `/bots` view: a team of AI teammates, each with a job. The view shows
bots and nothing else — it lives in its own `(bots)` route group, outside the
dashboard shell (no sidebar, header or status bar). You ask one for
something, and it does the work on **its own small computer** — a desktop with
Chromium — while you watch the screen live. The computer is a throwaway Docker
container: created for the session, deleted when the session ends.

The concept is the one Grok Bot popularised ("an AI teammate with its own
computer"); the implementation is Nexux's own and reuses what the sandbox
package already does.

Non-goals for this cut: teaching a task by demonstration, bots handing work to
each other, joining meetings, Slack/Telegram as a bot channel, routines (cron).
Each is additive on top of this shape.

## Shape

```
Bot ──< BotSession ──< BotRun
persona  one container   one prompt
```

- **Bot** — name, one-line job (`role`), standing `instructions`, color,
  optional `model`, optional `claudeCredentialId`, `idleMinutes`.
- **BotSession** — one lifetime of the computer: `starting → ready → stopped`
  (or `error`). Holds the container name, the noVNC port and its per-session
  password, and the Claude session id used to `--resume` the next prompt.
- **BotRun** — a prompt and its outcome, queued per session and executed in
  order, like the dev console.

## The computer (`@nexux/sandbox` `bot.ts`)

- Image `nexux-bot:<hash-of-recipe>`, built locally from a Dockerfile rendered
  in code and piped over stdin (no build context, works from the packaged app).
  `debian:bookworm-slim` because Debian's `chromium` is a real package on arm64
  and amd64; Ubuntu's is a snap and Google Chrome has no linux/arm64 build.
- Inside: Xvfb + fluxbox, x11vnc + websockify/noVNC, Chromium with DevTools on
  container-local `127.0.0.1:9222`, Node 22, Claude Code, `@playwright/mcp`
  (its bin is `playwright-mcp`). Fluxbox runs with no toolbar or decorations
  and maximizes every window, so Chromium fills the screen exactly.
- The dashboard embeds `nexux-screen.html`, a bare noVNC page shipped in the
  image: just the display, scaled, **view-only** by default. "Take control"
  flips it with a `postMessage` from the parent (no reconnect); control is
  scoped to the session. The full `vnc.html` (clipboard, extra keys) is the
  "open in a new tab" link.
- Clipboard and shortcuts on that page: ⌘+key is sent as Ctrl+key (⌘ never
  reaches Linux as Super); ⌘V pastes this Mac's clipboard (a hidden box takes
  the browser's own paste, then `clipboardPasteFrom` + Ctrl+V); ⌘C / ⌘X copy
  the remote selection back (x11vnc reports it, written with a pending
  `ClipboardItem` so WebKit keeps the gesture). The dashboard iframe grants
  `clipboard-read; clipboard-write`, and the computer view has a manual
  fallback: **Copy “…”** (latest remote clipboard) and **Paste text**.
  Runs as the non-root `bot` user (Claude refuses `bypassPermissions` as root).
- Claude drives **the visible Chromium** through the Playwright MCP over CDP, so
  every browser step is on the screen the user is watching. The bot's system
  prompt (`--append-system-prompt`) tells it about its computer, that it is
  ephemeral, and to ask (`NEEDS_INPUT:`) for logins and decisions.
- `docker run -d --rm --init --shm-size=1g`, no volumes, memory capped like
  local sandboxes, noVNC published on **host loopback only** with a random
  port, labelled `nexux-bot=1`.

## UI

Laid out like a chat app with teammates, on a neutral graphite theme scoped
to the view (`.dark:has(.bots-ui)` in `globals.css`, so portalled dialogs
match):

- **Inbox** (left): each bot's face, name and latest message (`preview`,
  from `GET /api/bots`), a blue dot for unread or "needs input", search, +.
  "Seen" is per-viewer browser storage (`nexux:bots-seen`), a convenience
  only. A small link at the bottom leads back to the dashboard.
- **Conversation**: floating name pill (opens the panel), your messages on the
  right, the bot's in grey bubbles, centred timestamps after 30-minute gaps, a
  `NEW` line at the first reply you had not seen, "New computer · fresh
  memory" between sessions, and **step chips** for what the bot did
  (`Browser Opened · https://…`), parsed from the run log by `botSteps`.
  "Needs your input" replies offer **Take control of the computer**.
- **Panel** (right, closable): big face, Activity (now / queued, the
  computer card with a live thumbnail, Asleep / Waking up / Awake / Working)
  and Settings (name, job, instructions, look, model, sleep-after, delete).
- **Computer view**: a large dialog with the live screen, Take control / Give
  back control, open full noVNC, wake up / put to sleep. **Giving control
  back** (the button, or closing the screen while driving) closes the dialog
  and, if the bot is idle, sends `HANDBACK_PROMPT` (`lib/bot-prompts.ts`):
  look at what changed (e.g. a sign-in), confirm it, carry on. The chat shows
  it as a system line ("You gave … its computer back"), not as your message.
  If the bot is already working, nothing is sent — it sees the screen anyway.
- **Create New Bot**: big preview, "Name your Bot", 13 shapes, 11 colors.
  Faces are Nexux's own: generated geometry (`lib/bot-shapes.ts`, stored as
  `Bot.shape`), not image assets.

Not built (no backend for them yet): routines ("Upcoming"), voice chat,
a file library, sharing.

## Behaviour: introductions and multiple-choice questions

- **A new bot says hi first.** `POST /api/bots` enqueues an intro prompt
  (`renderIntroPrompt`, tagged `[nexux:intro]`, built by `lib/bot-intro.ts`):
  the user's first name (git `user.name` — Nexux has no profile), their 12
  most recent Nexux projects, and a sample of their writing for language
  only. The bot greets them, guesses its purpose from its name/job and their
  projects, and asks where to start. Its computer wakes for this (Claude only
  runs in containers). Best effort: no Docker or token, no intro.
- **Questions come with options.** The system prompt (`renderBotSystemPrompt`)
  tells the bot to talk like a teammate and, for decisions, end with a
  `choices` block — `{"question", "options"}` JSON in a fenced block. The chat
  (`parseChoices`) renders it as a card: A, B, C… plus "Something else"
  (focuses the composer). Picking an option sends its text; the card then
  shows the pick (lettered, in the bot's color) and the answer has no bubble
  of its own. A choices reply counts as "needs your input" (unread dot), and
  the inbox previews the question.
- Prompts the user did not type (intro, hand-back) never show as bubbles.

## Routines

Recurring work a bot does on its own (`BotRoutine`: name, prompt, 5-field
cron in the host timezone, enabled, next/last run).

- **From the chat:** the system prompt lists the bot's routines and teaches a
  `routine` block — `{"name","cron","prompt","enabled"}` creates or updates (by
  name, case-insensitive), `{"name","delete":true}` removes. After a run,
  `applyRoutineSpecs` applies the blocks (invalid crons and incomplete new
  routines are rejected and logged). The chat shows "Updated routine ⏱ name".
- **From the panel:** "Upcoming" lists routines with their schedule in words
  (`describeCron`: "Every Monday around 8:00 AM") and an on/off switch in the
  bot's color; click to edit (picker: day / weekday / week / month / hour /
  custom cron), **Run now**, or delete. With none, "Suggested · Create a
  routine" (hideable).
- **Firing:** the bot manager's minute tick (`fireDueRoutines`) queues the
  routine's prompt, tagged `[nexux:routine:<id>] <name>`, which wakes the
  computer; the chat shows "Routine ⏱ name" instead of a bubble. A routine
  still queued or running is not fired again; one missed while Nexux was off
  fires once at the next tick.
- API: `GET/POST /api/bots/:id/routines`, `PATCH/DELETE …/:routineId`,
  `POST …/:routineId/run`; the feed carries `routines`.

## Tools (MCP servers)

Besides the browser MCP every bot has, a bot can have its own MCP servers:
`Bot.mcpServers`, Claude Code's native `mcpServers` JSON (the same shape a
project's sandbox takes), edited in the bot's Settings → "Tools (MCP
servers)". `lib/bot-mcp.ts` validates it on the form and the API: names
`[A-Za-z0-9_-]{1,40}`, `browser` reserved, stdio entries need `command`
(string `args`/`env`), `http`/`sse` entries need a `url` (string `headers`); a
pasted whole config (`{"mcpServers": …}`) is unwrapped; empty clears it.

- **On the computer:** before every prompt the manager writes them to
  `/home/bot/.nexux-mcp.json` (`writeBotMcpConfig`: over stdin, `umask 077`,
  since env/headers carry keys; removed when the bot has none) and Claude runs
  with `--mcp-config <browser config> <that file>`. So an edit applies on the
  next message, with no new computer.
- **The bot knows:** the system prompt lists the servers by name ("# Your
  tools") and says to prefer them over clicking through a site. A changed list
  changes the prompt hash, so the next prompt starts a fresh Claude session.
- **Limits:** stdio commands run inside the computer (Node/npx are there;
  Python/uvx are not). Secrets sit in the database in plain JSON, like a
  project's `mcpServers`. A server that authenticates with OAuth rather than a
  key is signed into on the bot's own screen — see
  [spec 37](37-bots-reset-and-mcp-signin.md), which also added
  `--strict-mcp-config` to the run.

## Emails for review

A bot never sends an email on its own. It drafts one as a `mail` block —
`{"from","to","cc","bcc","subject","body"}`, one per email — and the chat
shows each as a card (Mail · subject · From / To / Cc · body) that the user
edits in place, with **Discard** and **Send** (its menu: **Save as draft in
Gmail**).

- **Send / draft** (`POST /api/bots/:id/runs/:runId/mail`
  `{index, action, mail}`) queues a run on the same bot, tagged
  `[nexux:mail:<sourceRunId>:<index>:<send|draft>] <subject>` with the final
  draft as JSON. `mailForClaude` tells it to do exactly that from Gmail in its
  own browser — verbatim, from the given account, checking Sent/Drafts. Nexus
  holds no mail credentials: the bot's Google sign-in (kept per bot, see
  sign-ins) is what sends. The chat shows "✉ You sent “subject”" instead of a
  bubble, then the bot's one-line confirmation.
- **State** lives on the run that wrote the cards: `BotRun.mailState`, JSON
  by index — `{"status":"discarded"}` or `{"status":"sent","runId","mode"}`.
  The card then shows what went out, read-only, following that run
  (Sending… → Sent / Saved to Drafts). A card is acted on once (a double click
  cannot send twice: the write is conditional on the state it read); a send
  whose run errored or was stopped reopens the card for a retry.
- Addresses are checked loosely on the card and the route (To required; Cc/Bcc
  optional, comma-separated).

## Teammates (bot to bot)

- The system prompt lists the other bots (name + job) and teaches a
  `handoff` block — `{"to": "<bot name>", "message": "…"}`. After a run,
  `deliverHandoffs` queues each message on the named teammate (case- and
  space-insensitive match), waking its computer. Unknown names are dropped.
- The teammate's run prompt is tagged `[nexux:from:<botId>:<hop>] <name>`; its
  Claude reads it as a colleague's request (`handoffForClaude`), not the
  user's, and answers the same way. Chains stop at `MAX_HANDOFF_HOPS` (4).
- Files travel: outbox references in the message are collected like any
  reply's, and Nexus-relative links are made absolute for the receiving
  container (`absolutizeNexusLinks`), so the teammate can download them.
- Chat: the sender shows "Sent to ⟨face⟩ name" (opens that bot); the receiver
  shows the message with the sender's face and name. The team list is part of
  the system prompt, so adding or renaming a bot starts fresh Claude sessions
  (with the recent chat as context) on the next message.

## System prompt freshness

Claude Code keeps a session's first system prompt on `--resume`. Each
BotSession stores `systemPromptHash`; when the rendered prompt changes
(instructions edited, team changed, Nexus updated) the next run starts a fresh
Claude session on the same computer, with the recent chat. Routines ride as a
per-message note instead, so they don't reset memory.

## Showing files

Bots save files in `/home/bot/outbox` and reference them (`outbox://name`).
After each run `collectBotFiles` copies them to `~/.nexux/bot-files/<bot>/<run>/`
and rewrites the reply to `/api/bots/:id/files/:run/:name` (served sandboxed).
Several images in a row render as one line of thumbnails, opened as a
carousel (arrows, ← →, dots).

## The computer, like Grok Bot's

Researched against x.ai's own docs ("Every Bot has its own computer";
"Permissions and a shared computer: if you log into a site with one bot, every
other bot can reach that site too"; "a real, persistent desktop") and the user's
Grok transcripts (all bots share `/workspace`). So: one computer per bot
(parallel, no collisions), with shared files and shared sign-ins.

- **Desktop:** xfwm4 + xfce4-panel (bottom bar: Chrome / Terminal / Files
  launchers, open windows, clock), Thunar, xfce4-terminal, Adwaita-dark,
  graphite gradient (hsetroot). Chrome's launcher reuses the bot's profile, so
  it opens a window in the same running browser.
- **Shared workspace:** `~/.nexux/workspace` bind-mounted at `/workspace` in
  every computer; each bot works in `/workspace/<slug>/` (its cwd).
- **Persistent browser:** `~/.nexux/bot-profiles/<botId>` mounted as the
  Chromium profile (`--password-store=basic`; stale Singleton locks cleared).
- **Shared sign-ins** (`lib/team-cookies.ts`): cookies move over DevTools
  (`cookies.js get|set` in the image). After each run, every 30 s while the
  screen is open, and before sleeping, a computer's *own* changes (diffed
  against its snapshot, so a stale browser never overwrites a fresh login)
  go into `~/.nexux/team-cookies.json` (0600) and to every awake computer;
  a waking computer is seeded with the store. Host-only cookies are set by
  URL. Removals never travel: a site dropping a session in one browser must
  not sign every bot out.
- **Not Google.** Tested live: Google signs out a copied session (the same
  session rotating `__Secure-1PSIDTS` in two browsers), and a pushed copy
  would also break a bot's own sign-in. Google/YouTube/Gmail cookies are
  never shared (`isShareable`); each bot signs into Google once, kept in its
  own profile. A single shared team browser (one Chrome for all bots) would
  share Google too — left as an option if per-bot Google sign-ins get tedious.

## Credentials

The bot runs on the Claude subscription exactly like sandboxes do:
`resolveClaudeCodeToken(bot.claudeCredentialId)` → `CLAUDE_CODE_OAUTH_TOKEN`
injected at `docker run`. The value is passed through the docker client's
environment and referenced by name (`-e KEY`), so it is never in argv. `claude
-p` runs only inside the container — the host rule is untouched.

## Lifecycle (`apps/web` `lib/bot-manager.ts`)

- First prompt (or **Start**) creates a session and boots the container in the
  background; the first ever boot also builds the image (minutes).
- Prompts queue; one drain loop per session runs them in order, resuming the
  Claude session. Stop aborts the transport; End session deletes the container
  and cancels anything pending.
- An idle reaper (every minute) ends `ready` sessions with nothing pending and
  no activity for `idleMinutes`. Activity is a prompt **or the screen being
  open in the dashboard**: the computer view sends a heartbeat
  (`PATCH /api/bots/:id/session`) every minute, so the computer is never
  deleted while you are using it. (Before this, only prompts counted, and a
  sign-in done by hand was lost at the 30-minute mark.)
- A new computer means a fresh Claude, so its first prompt carries the recent
  chat (`withEarlierContext`, last 6 completed exchanges) plus a note that the
  machine was reset and nothing is signed in.
- Boot recovery deletes every `nexux-bot=1` container and settles their rows —
  a new process cannot supervise the old one's Claude runs.

## API

| Route | |
|---|---|
| `GET/POST /api/bots` | list (with `activity`) / create |
| `GET/PATCH/DELETE /api/bots/:id` | read / edit / delete (stops the computer) |
| `POST/PATCH/DELETE /api/bots/:id/session` | start / heartbeat / end the computer |
| `GET/POST /api/bots/:id/runs` | feed (latest session + last 100 runs) / send a prompt |
| `DELETE /api/bots/:id/runs/:runId` | cancel queued / stop running |

Starting over — clearing the memory, deleting the conversation, restarting the
computer — and signing into an MCP server are [spec 37](37-bots-reset-and-mcp-signin.md).

## Known limits

- The live screen is on `127.0.0.1`: it works when the dashboard is opened on
  the machine running Nexux (dev, native app). From a remote Nexus host over
  Tailscale the chat works but the screen does not — that needs a WS proxy
  through the terminal server, left for a follow-up.
- Claude's memory lives in the container, so a new session starts fresh
  (with the recent chat as context); the chat shows a divider there. Clearing
  it on purpose, without a new computer, is spec 37.
- Sign-ins do not survive the computer: the browser profile is deleted with
  it. Keeping a per-bot browser profile volume is the obvious next step if
  re-signing in gets tedious.
- The heartbeat comes from the computer view in the dashboard; driving the
  screen from the "open in a new tab" noVNC page does not keep it awake.
- npm packages in the image are unpinned; a rebuild picks up the latest Claude
  Code and Playwright MCP.
