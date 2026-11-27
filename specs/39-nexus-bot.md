# 39 — Nexus Bot: Nexus driven from a chat

**Status:** phase 1 in progress · 2026-11-26 · see D-102

## Goal

Stop using the dashboard. Everything the dashboard does today — create a
project (scan a folder, clone repos, bootstrap an idea), recognise its stack,
set up and launch a sandbox (Docker, Civo, AWS), run and schedule tasks, talk
to a sandbox — is done by talking to a bot. The bots view becomes the app.

## What the user sees

- **First run (and the home screen):** the bots view with one bot already in
  it, **Nexus**. It opens the conversation: "What do you want to do? Create a
  project · Clone a repository · Bootstrap an idea · Something else", as
  choice cards.
- **Creating a project** follows the same steps as the wizard, as questions:
  1. Where the code comes from: a folder on this Mac (Nexus scans it and shows
     the repos it found), Git URLs / GitHub repos (picked from the connected
     account), or an idea (name, description, project type, location).
  2. What it needs: skills to load, env vars, which saved credentials to use.
  3. Recognition: Nexus detects the stack, shows what it found (services,
     ports, run commands) and validates it; repairs it if asked.
  4. Sandbox: "Where should it run — Docker on this Mac, a Docker endpoint,
     Civo or AWS?", then size/region for cloud, and what to install. Launch,
     with progress in the chat.
  5. Team: "Do you want a developer, a designer, a QA?" — each answer creates
     a bot with that role, its instructions and skills, tied to the project.
- **Tasks:** "run the tests every night at 2" → a schedule; "fix issue #12 in
  the sandbox" → a task; progress and the result come back in the chat.
- **A sandbox is a chat too:** every running sandbox shows in the bots list
  next to the bots; opening it is its dev console (the same continuous
  session the dev console has today).

## How it works

- **Nexus is an assistant, not a bot with a computer:** no Docker, answers at
  once. It runs on the user's Claude Code subscription (the saved `claude`
  credential, no API key): Claude Code on the host, with the Nexus MCP server
  in its `--mcp-config` and nothing else — no shell, no file edits
  (`--allowedTools` limited to the Nexus tools). This needs the host rule in
  AGENTS.md/CLAUDE.md ("never `claude -p` on the host") to allow exactly this
  case; the user changes that rule, not the agent. Codex (ChatGPT
  subscription) is the second brain, already allowed on the host.
- **It drives Nexus through the existing MCP control surface**
  (`/api/mcp`, `packages/mcp`). Each run gets a short-lived, scoped token, the
  way vault access is granted per run today, and the Nexus MCP server is added
  to its `mcpServers`. Other bots don't get it unless the user turns it on.
- **New tools** (today the surface is mostly read + run tasks):
  - projects: `create_project` (manual / scanned / bootstrap), `scan_directory`,
    `list_git_accounts`, `list_git_repos`, `clone_repositories`, `import_config`;
  - stack: `detect_stack`, `save_stack`, `stack_up|down|logs`, `index_project`;
  - sandboxes: `get|set_sandbox_config`, `set_env_vars`, `destroy_sandbox`,
    `retry_sandbox_setup`, `launch_and_run_task`;
  - tasks: `create|list|toggle|delete_schedule`, `cancel_task`, `dev_prompt`;
  - credentials: `list_credentials` (names, providers and ids — never values),
    `add_credential` (the value is typed by the user into a secret card in the
    chat, never into the bot's message);
  - team: `create_bot`, `load_bot_skills`, `attach_bot_to_project`;
  - skills: `list_skills`, `install_skill`.
- **Secrets never reach the bot.** Credentials stay in Nexus and are referenced
  by id; Nexus applies them (clone tokens, cloud keys, Claude token) on its
  side. The bot reads pages and third-party skills, so anything it can see it
  can be talked into sending somewhere — the same reason the vault fills
  passwords without showing them.
- **Confirmation for what costs or destroys:** launching a cloud sandbox,
  destroying one, adding a credential and deleting anything need the user to
  tap a confirmation card. Enforced by Nexus, not only by the bot asking:
  those tools return "pending" and the action runs when the user confirms
  (the ⌘I assistant's pending-action flow, moved into the bot chat).
- **Bots get a project:** `Bot.projectId` (nullable). A project's team is its
  bots; their workspace folder is the project's checkout.

## Removing the dashboard

Phased, so nothing stops working in between:

1. **Nexus bot + first run + projects from the chat.** `/` goes to the bots
   view; the dashboard moves under "Advanced" (still reachable).
2. **Stack, sandboxes and credentials from the chat**, with confirmations.
3. **Tasks, schedules, and sandboxes as chats.**
4. **Team by roles** (`Bot.projectId`, role templates).
5. **Remove the dashboard pages** once each flow has a chat equivalent; keep
   Settings (providers, Docker endpoints, connectors) until they too have one.

**Agents** leave the UI now (nav, command palette, wizard step, home
counts). Their tables (`Agent`, `ProjectAgent`, `AgentSkill`) stay: dropping
them deletes data and needs its own decision.

## Decisions (2026-11-26)

- Nexus is the assistant, on the Claude Code / Codex subscription, no API keys.
- Confirmation only for what costs or destroys (cloud sandboxes, destroying,
  adding credentials, deleting).
- Start with phase 1.
- **One Nexus chat per project.** Before a project exists there is a
  "New project" chat; the moment it creates one, that conversation becomes the
  project's Nexus chat (it moves under the project) and a fresh "New project"
  chat takes its place.

## Done so far (phase 1, brain-independent)

- `/` opens the bots view, and the dashboard home is gone. The bots view's
  one link out is Settings (providers, credentials, Docker), the page left
  outside until the chat does it too. Agents left the sidebar and ⌘K; their
  pages still answer by URL.
- Project tools on the MCP surface, new scope `projects:write`:
  `nexux_get_project`, `nexux_scan_directory`, `nexux_list_bootstrap_types`,
  `nexux_list_git_credentials` (read); `nexux_create_project`,
  `nexux_clone_repositories` (background, followed with get_project),
  `nexux_detect_stack` (write). Creation is one function
  (`lib/project-create.ts`) shared with `POST /api/projects`; the scan and the
  detect cache moved to `lib/repo-scan.ts` and `lib/stack/detect-cache.ts`.
- A Git URL without a folder gets one (`<workspacePath or ~/Projects/<project>>/<repo>`),
  so it can be cloned without the wizard's location step.

- Then all of it: the bots view is the only page. Settings opens as a modal
  from its footer (`components/settings/settings-panel.tsx`; `/settings?tab=…`
  redirects to `/bots?settings=1&tab=…`), and every other dashboard page
  redirects to `/bots` (`next.config.ts`).
- Settings split into three modals from the bots view (`SettingsPanel`
  with `panel`): Vault (logins & secrets, AI providers, cloud, git), Connect
  apps (apps for bots, Telegram/Slack, GitHub/GitLab/ClickUp accounts) and
  Settings (machines, API tokens, terminal, appearance, desktop, backup). Until the chat exists, projects, sandboxes and tasks cannot be
  reached from the UI.

Next: the Nexus chat itself (blocked on the host rule), the "New project" chat
and its move under the project, then phase 2.

## The project chat (built)

- **Where it comes from:** the New Bot dialog asks first: **Assistant** (a
  teammate with a computer, as before) or **Project**. A Project is a bot of
  kind `nexus` (`Bot.kind`, `Bot.projectId`, migration
  `20261127000000_nexus_chat`): no computer, no details panel, no skills or
  attachments. It greets you with "where does the code come from?" and walks
  the wizard's steps; when `nexux_create_project` succeeds the chat binds to
  that project (and takes its name unless you named it). There is no
  always-there chat: you make one per project.
- **How it runs** (`lib/nexus-assistant.ts`): each message is `claude -p` on
  this machine with the saved Claude Code credential, `--tools ""`,
  `--strict-mcp-config` with only the Nexus MCP server, `--allowedTools`
  limited to the granted `nexux_*` tools, `--setting-sources local`,
  `--disable-slash-commands`, from an empty folder; `--resume` keeps the
  conversation. The MCP bearer is a per-run token held only in memory
  (`lib/nexus-run-tokens.ts`), scoped to `projects:read|write`,
  `sandboxes:read`, `tasks:read` and to the chat's workspace, revoked when the
  run ends. Runs hang off a `BotSession` with status `host`, which the reaper
  and recovery ignore.
- Checked by hand: a Project chat greeted in ~6 s and, asked for
  `~/Projects/ideascol/nexux`, called `nexux_scan_directory` and offered the
  repo as a choice.

## Sandboxes from the project chat (built)

- After recognising the project the chat offers to run it: `nexux_sandbox_options`
  says what this install can do (Docker here, Docker endpoints, Civo/AWS with
  a saved credential and terraform) and the chat offers only those, as choices.
- `nexux_launch_sandbox` from a chat: local and endpoint sandboxes launch at
  once. A cloud one throws `NeedsConfirmation`; the chat ends its reply with a
  ```` ```confirm ```` card; **Confirm** is an API call
  (`POST /api/bots/:id/confirm/:actionId`) that approves exactly that action
  once (`lib/nexus-confirmations.ts`, memory only, 30 min), and the chat's
  retry goes through. A message the model writes cannot approve anything.
- The chat may not pause/resume, reset data or repair the stack yet (denied
  per run even though `sandboxes:write` covers them).
- Checked by hand on Hawkeye: options listed Docker on this Mac and Civo (no
  AWS credential), and picking Civo produced the confirm card with no sandbox
  created.

- Every place is always offered (Docker here, endpoints, Civo, AWS); a cloud
  with no key reads "(needs a key)". Picking it shows an ```` ```add-credential ````
  card (AWS: access key ID + secret; Civo: API key) that posts to
  `/api/credentials` and runs its Test directly from the page — the key never
  passes through the chat or the model — then tells the chat to carry on.
- A sandbox launched from the chat reports by itself (`lib/nexus-sandbox-watch.ts`):
  Nexus polls it every 5 s and posts its `[nexux] …` provisioning steps into
  the chat (batched every 15 s, as `[nexux:notice]` runs the chat hides the
  prompt of), then ✅ ready with the preview or ❌ the error, and queues one
  `[nexux:sandbox]` message so the assistant knows and adds a line on what's
  next — with no question. The assistant is told never to poll or ask.
- When it lands, the assistant leads: what is next (the fix if it failed, what
  is still missing if it is up) and a choices block of next steps.
- A project chat's right panel is its sandbox (`components/bots/project-sandbox-panel.tsx`),
  as the computer is an assistant's: it opens by itself once the project has a
  sandbox (a "Sandbox" button reopens it), with a live terminal inside it once
  running (the same pty server as the old terminal page: `docker exec` for a
  local one, ssh for a cloud one), its setup log while it boots, and Preview.
- Attachments work in project chats: images and PDFs go inside the message as
  content blocks (stream-json stdin), small text files inline, anything else
  is named — the chat still has no file tools (`lib/nexus-attachments.ts`).
- The right panel is surfaces in tabs (T3 Code's layout): any number of
  terminals, Files (read-only browse of `/opt/nexus` through
  `GET …/sandboxes/:id/files`, paths checked and shell-quoted), Setup log and
  Preview; "+" or T/F/L/P opens one, an empty panel lists them, and it can
  expand over the chat.
- Details shows and edits the project: repositories and folders (add a folder
  or a Git URL — cloned at once — or remove one from the project, files kept),
  the skills its sandboxes load, and its Telegram chat / Slack channel
  (`PATCH /api/projects/:id/notifications`, which leaves the rest of the
  sandbox setup alone).
- **Floating card** (after T3 Code's): clicking a project chat's name opens a
  card over the chat — where it runs (sandbox · status), Open in Finder
  (`POST /api/projects/:id/reveal`, only the project's saved folder), Open a
  terminal, its repositories (first, "Show N more"), its open pull requests
  (→ the Pull requests surface) and Settings.
- **Pull requests** surface (R): GitHub PRs and GitLab merge requests across
  the project's repositories, newest first, Open / All, with state, author,
  repo, branch → target and age; a click opens it on its site
  (`GET /api/projects/:id/pull-requests`, `lib/project-prs.ts`). Read with
  the Vault's git tokens server-side; an unknown host is tried as a
  self-hosted GitLab when a GitLab token exists; a repo it cannot read says
  why.
- **No sandbox needed to read the code:** `nexux_list_files` and
  `nexux_read_file` (new scope `files:read`, granted to project chats) list
  and read a project's repositories on this machine — inside the repo only
  (symlinks resolved), text up to 200 KB, and never secrets (.env files,
  private keys, credential files, `.git` internals: listed as secret, not
  read) (`lib/project-files.ts`).
- **The panel works without a sandbox:** a terminal opens on this Mac in the
  project's folder (main repository's, else the project's) when no sandbox
  runs — with one running, "+" offers both, and a Mac terminal shows a laptop
  icon. Files browses the repositories on this Mac (`GET /api/projects/:id/files`,
  the same rules as the chat's file tools; secrets show locked), with a
  This Mac / Sandbox switch while a sandbox runs. Setup log and Preview still
  need a sandbox.
- **Editing locally:** `nexux_edit_file` (exact text, once or `all`) and
  `nexux_write_file` (create or replace), scope `files:write`, granted to
  project chats: inside the repository only (symlinks and the nearest existing
  folder checked), never secrets or `.git`. `nexux_read_file` now returns
  numbered lines in ~12 KB parts with a `next` offset — Claude Code moves a
  bigger tool result to a file the chat cannot open, which cut a 55 KB file to
  its first 2 KB. No shell: commands go in the panel's Terminal.
- **Composer and model picker:** the chat input is a card — attachments on
  top, the text full width, and a bottom row with 📎 on the left and the
  model chip + Send on the right. The chip opens a picker (models with search
  and ⌘1–4, any other id as typed, or Claude Code's default; reasoning Low →
  Max or default), saved on the bot (`Bot.model`, new `Bot.effort`, migration
  `20261128000000_bot_effort`) and passed as `--model` / `--effort` from the
  next message, for assistants and project chats alike.
- **Replies read like a chat:** `MarkdownReport variant="chat"` (body-size
  text in the foreground colour, real lists and headings, inline code chips),
  and every fenced block — any variant — is a `CodeBlock`: language, wrap
  toggle, copy, highlighted (Prism, languages loaded on demand). A link to a
  path on this Mac (`/Users/…/a.ts:42`, `~/…`, `file://`) opens in the user's
  editor at that line (`POST /api/open-file`, only inside a project's folders;
  the "Open in" choice from the floating card); web links open in the browser
  as before.

**Tasks in a project's Details (2026-11-27).** A plain to-do list at the top of the project chat's Details: add with Enter, tick off (optimistic), double-click to rename, delete. Each can carry the pull request that closed it — picked from the project's own PRs (`/pull-requests`, shown with its live state) or any pasted link (`lib/pr-link.ts`). Done ones fold under "Completed", newest first; a hairline bar shows progress. Model `ProjectTodo` (migration `20261129000000_project_todos`), routes `/api/projects/:id/todos[/:todoId]` — `/tasks` already means sandbox runs.

**A bot at work, streamed (2026-11-27).** While a run works the chat shows three dots in the bot's colour and one shimmering line ("Thinking it through", "Waking up", or the step it is on); once words arrive, the reply itself grows in a bubble (typewriter-smoothed, a caret at the end) with "Typing…" under it. Watch and Stop left the bubble: the composer's send button turns into Stop while a run is going or queued (typing something brings send back, to queue the next message). Streaming: both runners ask Claude for `--include-partial-messages`; `nextDraft` (sandbox `remote.ts`) turns text deltas into the reply so far, kept in process memory (`lib/run-drafts.ts`) until the result is saved, and polled at `GET /api/bots/:id/runs/:runId`. The Nexus chat now also reads stream-json, so its tool calls show as steps too. Card blocks (choices, mail…) are held back from the draft (`lib/run-draft-view.ts`) and appear with the finished reply.
