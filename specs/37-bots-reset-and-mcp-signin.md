# 37 — Starting over with a bot: memory, computer, and MCP sign-ins

**Status:** shipped (v1) · 2026-11-25 · see D-98

## Goal

Three things a bot's chat had no answer for:

1. **The conversation drifts.** A bot that has been told the wrong thing for an
   hour keeps carrying it: the only way to a clean slate was deleting the bot.
2. **The computer gets wedged**, or has to be swapped (a sign-in to pick up, a
   desktop that stopped answering). "Put to sleep" plus "Wake up" does it, in
   two steps, with the queue thrown away in between.
3. **An MCP server with its own OAuth could not be signed into at all.** Spec
   31's own limit: "OAuth-only remote MCPs can't complete a sign-in headless:
   use API keys". But the bot *has* a desktop and a browser — the sign-in just
   had nowhere to happen.

They share a shape: the bot's memory and its machine are two different things,
and the UI never said which one you were resetting.

## Clearing the memory

**Clear the memory** (the chat's ⋯ menu) drops what the bot remembers and
leaves everything else alone.

Claude's memory lives inside the container and Nexus cannot reach into it, so
clearing is two moves: the session's `claudeSessionId` is dropped (the next
prompt starts a fresh Claude, like an instructions change already did), and
`Bot.contextClearedAt` is set — the line `withEarlierContext` stops replaying
at. Nothing said before that moment reaches the bot again.

- On the **bot**, not the session: clearing while the computer is asleep still
  holds for the next one, which would otherwise be handed the recent chat.
- The chat keeps every message, with a **Memory cleared** line where the bot's
  memory now begins — it is the user's record, not the bot's context.
- The computer is untouched: files, open pages and sign-ins stay. The first
  prompt afterwards says exactly that (`withEarlierContext` reason `cleared`),
  so the bot does not re-do sign-ins it still has.

**Delete the conversation** is the other half: every `BotRun` and the files the
bot handed over in them, and the memory with them (a chat the user cannot see
is not context the bot should still be working from). Anything queued or
running is stopped first, so a reply cannot land in an emptied chat. Routines,
sign-ins and the shared workspace stay — they are not part of the chat.

## Restarting the computer

**Restart the computer** (the chat's ⋯ menu, and the button next to the power
button on the screen) deletes the container and boots a fresh one:
`restartBotSession` = `stopBotSession` + `startBotSession`, with the
conversation kept.

- **Queued prompts survive**, re-pointed at the new session instead of
  canceled: restarting a wedged machine was never a request to lose the work
  waiting behind it. Anything *running* cannot survive — its Claude died with
  the container — and ends canceled, as it does on any stop.
- A new computer means a fresh Claude, which gets the recent chat as context
  like any other new computer, with the note that the machine was reset.
- `POST /api/bots/:id/session/restart`.

**The bot can ask for one.** It cannot run the restart itself — the shell that
would do it dies mid-reply — so it ends a reply with a block, like routines,
handoffs and mail:

```restart
{"reason": "the desktop stopped answering"}
```

The manager acts on it after the reply and its files are out of the container
(`parseRestartBlocks`, `lib/bot-restart.ts`), then queues one message on the
new computer so the bot checks what it restarted for and carries on. The chat
shows a system line, not a bubble. Guards: one block per reply, and never in
answer to a restart of its own, so a bot that believes a restart will fix
things cannot spin on it. The system prompt also says what a restart is *not*
for: a tool the user just added needs no restart.

## MCP sign-ins (OAuth)

Claude Code keeps an MCP server's OAuth token under the server's name plus a
hash of its `type`, `url` and `headers` — **not** under the config it was
declared in. That is what makes this work: a sign-in done once inside the
computer is found again by every run, which declares the same server through
`--mcp-config`.

- **The sign-in runs on the bot's desktop.** `claude mcp login <name>` in an
  `xfce4-terminal` window, which opens the consent page in the bot's own
  Chromium. The user takes control of the screen and approves. It cannot be
  done from the host, and not even with `docker exec`: verified in the bot
  image, `claude mcp login` refuses outright with *"this isn't an interactive
  terminal"* unless it has a TTY, and the OAuth callback is a redirect to a
  port only a browser inside that computer can reach. The window keeps the
  outcome on screen and tees it to `/tmp/nexux-mcp-login.log`.
- **`claude mcp login|logout|get` ignore `--mcp-config`** (verified), so the
  server is written into the computer's own Claude config first
  (`registerBotMcpServer`, over stdin — headers carry keys). That registration
  is throwaway: it dies with the container, and runs now pass
  **`--strict-mcp-config`** so what a prompt loads is exactly the two files it
  is given, never something a sign-in left behind.
- **The token outlives the computer.** Verified: a login attempt writes
  `/home/bot/.claude/.credentials.json` (0600) whose only key is `mcpOAuth`,
  with one entry named `<server>|<16 hex>` — the name plus that hash, nothing
  about the scope. `/home/bot/.claude` is mounted from
  `~/.nexux/bot-claude/<botId>` (0700), beside the browser profile — a named
  volume on another machine's daemon, like the rest. So a server is signed into
  once, not once per computer. Deleting the bot deletes it.
- **Status, per server** (`GET /api/bots/:id/mcp`): `claude mcp get <name>`
  health-checks and prints one `Status:` line, read as connected / needs a
  sign-in / failed (`readMcpState`). Shown in the panel's Tools section, with
  **Sign in** on the one state that can be acted on. Asked when the panel opens
  and on **Check again**, not on a timer. stdio servers are listed but never
  checked — the check would run their command, and the usual `npx -y` on a
  fresh computer is a download of a minute or more.
- `POST /api/bots/:id/mcp/login {server}` needs an awake computer and refuses a
  stdio server or one whose vault secret is missing, by name.

## Known limits

- The sign-in has to be approved by hand, on the screen: there is no way to
  consent on the user's behalf, which is the point.
- A server whose `url` or `headers` change gets a new credential key, so it
  asks for a sign-in again. Rotating a key in the Vault therefore means one
  more consent for a server that signs in with OAuth *and* a header.
- `claude mcp get` is a health check: a server that is up but slow can read as
  failed on a cold computer. **Check again** is the answer.
- Clearing the memory leaves Claude's own session files inside the container
  (nothing resumes them). They go when the computer does.
