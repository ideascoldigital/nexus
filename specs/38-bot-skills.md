# 38 — Skills for a bot, from the chat's "/" menu

**Status:** shipped (v1) · 2026-11-26 · see D-100

## Goal

The skill library (Skills page, skills.sh installs, `~/.claude/skills` sync)
only reached projects and agents. A bot runs Claude Code in its own computer
and could not use any of it, so a skill the user already had — "pdf",
"frontend-design" — had to be pasted in as instructions.

## What the user does

- Types `/` at the start of a message. A menu opens over the composer:
  **/skills**, then every skill this bot has loaded. Arrows, Enter or Tab pick;
  Escape closes it; typing filters (name first, then the skill's description).
- **/skills** opens a dialog with two tabs:
  - **Library**: the workspace's skills, plus the machine-wide ones in the
    default workspace, each with a switch. On means loaded on this bot.
  - **Install from skills.sh**: search the registry; **Install & load** puts
    the skill in the library (`~/.claude/skills/<name>/`, as the Skills page
    does) and loads it on this bot. If the library already has that name, the
    button reads **Load** and only loads it.
- Picking a skill from the menu puts a **Using <skill>** chip over the
  composer (× or Backspace on an empty box removes it). The next message is
  sent as `/<skill> what you typed` — or just `/<skill>`, in which case the
  bot asks what is needed — and its bubble shows the chip again. Typing
  `/<skill> what to do` by hand does the same.
- Nothing runs on install or on picking: a loaded skill is there for the bot's
  next message, used when the task fits or when asked for by name.

## How it reaches the bot

- `BotSkill(botId, skillId)` records what is loaded. Deleting the bot or the
  skill removes the row.
- Before every prompt, `drain` reads the loaded skills
  (`services/bot-skill-store.ts`) and `syncBotSkills` writes them into
  `/home/bot/.claude/skills`. That folder is under the per-bot Claude volume
  (spec 37), so it persists, and Claude Code discovers skills there on its own.
  No system-prompt change, so loading a skill does not restart the Claude
  session.
- A skill backed by a `SKILL.md` on disk is sent with its whole folder
  (scripts, references), capped at 200 files / 5 MB and skipping `.git` and
  `node_modules`. A skill that exists only in the database becomes a
  `SKILL.md` built from its name, description and body.
- The sync is one `docker exec` with the files on stdin, so it works on a
  remote daemon too. A manifest (`.nexux-skills.json`) records what Nexus
  wrote. Only those folders are rewritten or removed, so a skill the bot made
  itself is left alone. Names must be one safe path segment, and a file path
  that would leave its skill's folder is dropped.
- `/<skill> rest` is rewritten for the bot into "Use your "<skill>" skill for
  this — load it first and follow it." plus the rest. A `/word` that is not a
  loaded skill reaches the bot unchanged.

## Limits

- Installing from skills.sh goes through the GitHub API first (60 requests an
  hour without a GitHub credential, shared by the IP). When the API refuses,
  the repo's tarball from codeload.github.com is unpacked instead: no API
  quota, and the skill arrives with its whole folder. Through the API it
  arrives with `SKILL.md` only.
- A skill is instructions the bot follows with its permissions bypassed. The
  dialog says to read one before loading it. Nothing vets the content.
- Not verified with a live bot run: that Claude Code picks the skill up was
  taken from how it treats `~/.claude/skills`. The write itself was checked in
  the bot image.
