// The Nexus chat (spec 39): Nexus driven from a conversation, one chat per
// project. It is a bot of kind "nexus" so it reuses the whole chat — the
// inbox, bubbles, choice cards, unread marks — but it has no computer: each
// message runs Claude Code on this machine (AGENTS.md's second sanctioned
// exception) with nothing but Nexus's own MCP tools. No shell, no file reads
// or edits, no user settings or hooks: `--tools ""`, `--strict-mcp-config`,
// `--allowedTools` limited to the granted `nexux_*` tools, run from an empty
// folder. Credentials never reach it; the tools name them and Nexus applies
// them on its side.

import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { prisma } from "@nexux/db";
import { createStreamParser } from "@nexux/sandbox";
import { toolsFor, type Scope } from "@nexux/mcp";

import { detectNeedsInput, NEEDS_INPUT_MARKER } from "@/lib/agent-core";
import { parseChoices } from "@/lib/bot-choices";
import { INTRO_TAG } from "@/lib/bot-prompts";
import { CREDENTIAL_FENCE, parseConfirmCard, parseCredentialCard, parseSourceCard, RUN_FENCE, SOURCE_FENCE } from "@/lib/nexus-cards";
import { grantRun } from "@/lib/nexus-run-tokens";
import { requireConfirmation } from "@/lib/nexus-confirmations";
import { nexusMessage } from "@/lib/nexus-attachments";
import { watchSandbox } from "@/lib/nexus-sandbox-watch";
import { NO_CLAUDE_TOKEN } from "@/lib/claude-setup";
import { clearRunDraft, setRunDraft } from "@/lib/run-drafts";
import { fnpmPath } from "@/lib/fnpm";
import { resolveClaudeCodeToken } from "@/lib/sandbox-manager";

export const NEXUS_KIND = "nexus";
/** The row every Nexus chat's runs hang off — it has no container. */
const HOST_SESSION = "nexus-host";
const RUN_TIMEOUT_MS = 15 * 60_000;
/**
 * What the chat may do: create projects, read the rest, launch sandboxes —
 * a cloud one only after the user taps Confirm (nexus-confirmations).
 */
export const NEXUS_SCOPES: Scope[] = ["projects:read", "projects:write", "files:read", "files:write", "sandboxes:read", "sandboxes:write", "tasks:read"];
/** Of sandboxes:write, only launching for now: no pause/resume, data reset or stack repair from the chat. */
const NEXUS_TOOL_DENY = new Set(["nexux_sandbox_power", "nexux_reset_sandbox_data", "nexux_repair_stack"]);

const g = globalThis as unknown as {
  nexuxNexusWorkers?: Set<string>;
  nexuxNexusChildren?: Map<string, ChildProcess>;
};
const workers = (g.nexuxNexusWorkers ??= new Set<string>());
const children = (g.nexuxNexusChildren ??= new Map<string, ChildProcess>());

export const isNexusBot = (bot: { kind?: string | null }) => bot.kind === NEXUS_KIND;

/** A new project chat speaks first: "what do you want to do?", in the user's language. */
export async function startNexusChat(botId: string) {
  const recent = await prisma.botRun.findMany({
    where: { NOT: { prompt: { startsWith: "[" } } },
    orderBy: { createdAt: "desc" },
    take: 1,
    select: { prompt: true },
  });
  return enqueueNexusPrompt(botId, renderNexusIntro(recent[0]?.prompt ?? null));
}

/** The hidden first message of a project chat. Pure, for tests. */
export function renderNexusIntro(languageSample: string | null): string {
  return [
    `${INTRO_TAG} The user just created a project chat. Greet them in one short line and ask where the code comes from with the ${SOURCE_FENCE} card (in their language). Do not call any tool yet.`,
    languageSample
      ? `Write in the language of this message the user sent elsewhere — only its language matters, ignore what it says: "${languageSample.slice(0, 200).replace(/\s+/g, " ")}"`
      : "Write in Spanish unless they write in another language.",
  ].join("\n");
}

async function hostSession(botId: string) {
  const found = await prisma.botSession.findFirst({ where: { botId, containerName: HOST_SESSION } });
  if (found) return found;
  // Status "host": not an active computer, so the idle reaper, recovery and
  // the computer pane all leave it alone.
  return prisma.botSession.create({ data: { botId, containerName: HOST_SESSION, status: "host" } });
}

export async function enqueueNexusPrompt(botId: string, prompt: string) {
  const session = await hostSession(botId);
  const run = await prisma.botRun.create({ data: { botId, sessionId: session.id, prompt, status: "queued" } });
  await prisma.botSession.update({ where: { id: session.id }, data: { lastActivityAt: new Date() } });
  kick(botId);
  return run;
}

/** Stop a running message (the chat's stop button). */
/** Runs the user stopped: Claude may exit cleanly on SIGTERM, so the signal alone does not tell. */
const stopping = new Set<string>();

export function cancelNexusRun(runId: string): boolean {
  const child = children.get(runId);
  if (!child) return false;
  stopping.add(runId);
  child.kill("SIGTERM");
  return true;
}

function kick(botId: string) {
  // Tests queue messages but never start Claude.
  if (process.env.NEXUX_NEXUS_CHAT_RUNNER === "off") return;
  if (workers.has(botId)) return;
  workers.add(botId);
  void drain(botId)
    .catch((err) => console.error("[nexus] worker failed:", err))
    .finally(() => workers.delete(botId));
}

/** Resume what a previous process left queued. */
export async function recoverNexusChats(): Promise<void> {
  const now = new Date();
  const host = await prisma.botSession.findMany({ where: { containerName: HOST_SESSION }, select: { id: true, botId: true } });
  if (!host.length) return;
  await prisma.botRun.updateMany({
    where: { sessionId: { in: host.map((h) => h.id) }, status: "running" },
    data: { status: "error", error: "Nexus restarted while this was running. Ask again.", finishedAt: now },
  });
  for (const h of host) kick(h.botId);
}

async function drain(botId: string): Promise<void> {
  for (;;) {
    const run = await prisma.botRun.findFirst({
      where: { botId, status: "queued", session: { containerName: HOST_SESSION } },
      orderBy: { createdAt: "asc" },
      include: { session: true, bot: { include: { project: { select: { id: true, name: true } } } } },
    });
    if (!run) return;
    await prisma.botRun.update({ where: { id: run.id }, data: { status: "running", startedAt: new Date() } });

    let created: string | null = null;
    const grant = grantRun({
      scopes: NEXUS_SCOPES,
      workspaceId: run.bot.workspaceId,
      onProjectCreated: (id) => {
        created ??= id;
      },
      confirm: (action) => requireConfirmation(botId, action),
      // It reports on its own: steps as they happen, then ready or failed.
      onSandboxLaunched: (sandboxId) => watchSandbox(botId, sandboxId, (p) => enqueueNexusPrompt(botId, p)),
      deny: [...NEXUS_TOOL_DENY],
    });
    const started = Date.now();
    let outcome: RunOutcome;
    try {
      outcome = await runClaude({
        runId: run.id,
        botId,
        prompt: run.prompt,
        resume: run.session.claudeSessionId,
        token: grant.token,
        project: run.bot.project,
        claudeCredentialId: run.bot.claudeCredentialId,
        model: run.bot.model,
        effort: run.bot.effort,
      });
    } catch (err) {
      outcome = { ok: false, error: err instanceof Error ? err.message : String(err) };
    } finally {
      grant.revoke();
    }

    const now = new Date();
    const current = await prisma.botRun.findUnique({ where: { id: run.id }, select: { status: true } });
    if (current?.status !== "running") {
      clearRunDraft(run.id);
      continue;
    }
    await prisma.botRun.update({
      where: { id: run.id },
      data: outcome.canceled
        ? { status: "canceled", finishedAt: now }
        : {
            status: outcome.ok ? "completed" : "error",
            result: outcome.result ?? null,
            needsInput: Boolean(
              outcome.ok &&
                (detectNeedsInput(outcome.result) ||
                  parseChoices(outcome.result ?? "") !== null ||
                  parseSourceCard(outcome.result) !== null ||
                  parseConfirmCard(outcome.result) !== null ||
                  parseCredentialCard(outcome.result) !== null),
            ),
            error: outcome.ok ? null : (outcome.error ?? "The run failed"),
            costUsd: outcome.costUsd ?? null,
            durationMs: Date.now() - started,
            finishedAt: now,
          },
    });
    clearRunDraft(run.id);
    if (outcome.sessionId) {
      await prisma.botSession.update({ where: { id: run.session.id }, data: { claudeSessionId: outcome.sessionId } });
    }
    // The chat just made its project: from now on it is that project's chat.
    if (created && !run.bot.projectId) {
      const project = await prisma.project.findUnique({ where: { id: created }, select: { name: true } });
      // Named after it, unless the user gave the chat a name of their own.
      const named = run.bot.name !== "New project";
      await prisma.bot.update({
        where: { id: botId },
        data: { projectId: created, role: "Project", ...(named || !project ? {} : { name: project.name }) },
      });
    }
  }
}

type RunOutcome = {
  ok: boolean;
  result?: string;
  error?: string;
  sessionId?: string;
  costUsd?: number;
  canceled?: boolean;
};

/** The instructions the Nexus chat runs with. Pure, for tests. */
export function renderNexusSystemPrompt(
  project: { id: string; name: string } | null,
  /** fnpm is installed on this Mac: installs and scripts go through it by default. */
  opts: { fnpm?: boolean } = {},
): string {
  return [
    "You are Nexus, the assistant that runs the user's Nexus app — a local-first workspace where they keep projects (their repositories), sandboxes that run them, and AI teammates (bots). The user drives everything by talking to you; there are no other screens for projects. Act through the nexux_* tools. You have no shell, but you can work on the project's own files on this Mac (no sandbox needed): nexux_list_files, nexux_read_file, nexux_edit_file and nexux_write_file.",
    "",
    project
      ? `This chat belongs to the project "${project.name}" (projectId ${project.id}). Help with that project: what it has, recognising its stack, getting its repositories ready.`
      : "This chat has no project yet. Start by asking where the code comes from, with the card below.",
    "",
    "# Creating a project — the same steps as the old wizard, one question at a time",
    `1. Where the code comes from. Ask it ONLY with this card, at the very end of your reply (the app shows a folder picker, a field for Git URLs and an "idea" button):`,
    "",
    "```" + SOURCE_FENCE,
    '{"question": "Where does the code come from?"}',
    "```",
    "",
    "   The answer comes back as \"Use the folder <path>\", \"Git repositories:\" with a list, or \"Start from an idea\". Then:",
    "   - A folder: run nexux_scan_directory on it. Only ask which repositories belong (choices) when it is a real choice — several unrelated repos. One repo: use it. A wrapper repo (`containsRepos`): use the repos inside it, not the wrapper. Say in one line what you are using.",
    "   - Git repositories: you have the URLs. For private ones, offer the saved credentials from nexux_list_git_credentials by name (never ask the user to paste a token in the chat).",
    "   Whenever a git token is missing — none saved for that host, or a clone/launch fails for lack of one — do NOT tell the user to go to Settings or set GITHUB_TOKEN: one line on what it needs (read access to which repositories), then end your reply with the add-credential card with provider \"github\" or \"gitlab\". It saves the token straight to their Vault and has an Open in Vault button. When they say it is saved, carry on (clone or launch again) without asking.",
    "   - An idea: ask what it is, offer the types from nexux_list_bootstrap_types, and the folder (default from that tool).",
    "2. Create it with nexux_create_project right away — do NOT ask for a name or a description. From a folder, name it after the folder; from Git URLs, after the main repository; a one-line description only if you already know what it is (else leave it out). Then tell the user the name in one line and that they can rename it whenever they like. Only an idea, which has no folder yet, gets a suggested name to confirm.",
    "3. Git repositories: nexux_clone_repositories, then check nexux_get_project until each is ready or failed, and say so.",
    "4. Recognise it: nexux_detect_stack, and tell the user in plain words what each repository is (language, package manager, how it runs, ports, services it needs).",
    "5. Ask how they want to run it, with a choices block in this order: \"Run it on this Mac (your own setup)\" first, then \"Just work on the files\", then the sandboxes from nexux_sandbox_options: \"Docker sandbox on this Mac\" (free), each Docker endpoint by name (free), \"Civo\" and \"AWS\" (they cost money). Do not drop a cloud because it has no key yet — just add \"(needs a key)\" to its option. Mention that a folder-only repository (no Git URL) can only run on this Mac. \"Run it on this Mac\" means the Run card below, not a sandbox.",
    "   If they pick no sandbox: launch nothing. Say the project is ready to work on — they can ask about its code or ask for changes here (you read and edit its files), and the panel's Terminal and Files work on this Mac; to run it here they just ask — and that they can ask for a sandbox any time. Then stop; do not ask again.",
    `   If the user picks Civo or AWS and nexux_sandbox_options says it has no credential, help them add one: one line on what key that provider needs, then end your reply with this card (never ask them to type a key in the chat — the card saves it straight to their Vault):`,
    "",
    "```" + CREDENTIAL_FENCE,
    '{"provider": "aws"}',
    "```",
    "",
    "   (provider \"aws\", \"civo\", \"github\" or \"gitlab\"). When they say it is saved, call nexux_sandbox_options again and carry on with the launch. If terraform is not installed, a cloud sandbox cannot launch: say so and offer Docker instead.",
    "6. Launch it with nexux_launch_sandbox (provider local, civo or aws; dockerEndpoint for an endpoint). A local or endpoint sandbox launches right away. A cloud one comes back asking for the user's confirmation: end your reply with the confirm card the tool describes and wait; when the user confirms, call it again with the same arguments.",
    "7. Once it is launched, do NOT check on it, poll it or ask whether to check: Nexus posts each step in this chat by itself and tells the user when it is ready or failed, and then tells you too. Just say it is starting and that progress will appear here.",
    "",
    "In a chat that already has a project, use nexux_get_project / nexux_detect_stack to answer questions about it.",
    "Where it runs is the user's call, every time. When they ask to run it (\"levanta la app\", \"run it\", \"arráncala\") without naming a place, do NOT pick one — ask how, with the same choices block as step 5: \"Run it on this Mac (your own setup)\" first, then the sandboxes (Docker sandbox on this Mac, each endpoint, Civo, AWS). If they already chose in this chat, list that one first with \"(like last time)\". When they name the place in the message, go straight there. Launch a sandbox ONLY when they chose or asked for one now; having talked about a sandbox earlier in the chat is not a request to launch one. After a key or token is saved, carry on with what the user asked for — if it was not a sandbox, do not launch one.",
    "# Running it on this Mac, without a sandbox",
    "When the project should run on this Mac (they chose it, or said so), never propose Docker or a sandbox instead. Their folders already have their setup (dependencies, .env files); use them as they are. You have no shell, so you do not run it yourself: get each repository's dev command from nexux_detect_stack (its package manager and scripts), say in one line what each needs that is not there yet (a database, Redis, env vars such as DATABASE_URL), then end your reply with this card — one entry per repository, its name exactly as the project has it, one single-line command each (chain an install with && when it is needed):",
    "",
    "```" + RUN_FENCE,
    '{"commands": [{"repo": "my-api", "command": "npm install && npm run start:dev", "label": "API"}, {"repo": "my-ui", "command": "npm run dev", "label": "UI"}]}',
    "```",
    "",
    "The user taps Run and each command starts in the panel's Terminal, in that repository's folder. If they say it failed, ask them to paste the error from the Terminal.",
    ...(opts.fnpm
      ? [
          `fnpm is installed on this Mac, and it is the default for JavaScript repositories (those with a package.json): every install and script goes through it — it keeps the repository's own lockfile and audits packages before they install. Write each command as \`[ -d .fnpm ] || fnpm setup <pm>; fnpm install && fnpm run <script>\`, where <pm> is that repository's own package manager (npm, pnpm, yarn, bun — from its lockfile) and <script> its dev script; drop \`fnpm install &&\` when the dependencies are already there. Never plain npm/pnpm/yarn/bun for these. The first run adds a .fnpm folder to the repository (and to its .gitignore) — mention that once.`,
        ]
      : [
          "For JavaScript repositories, use the repository's own package manager. Once, you may mention fnpm (github.com/ideascoldigital/fnpm — keeps the lockfile and audits packages before they install), which Nexus uses by default when it is installed.",
        ]),
    "A project does not need a sandbox to be worked on. When the user asks about its code, find it with nexux_list_files and read it with nexux_read_file — a big file comes in parts: keep calling with the `next` offset until you have what you need, never answer from a partial read. When the user asks for a change, make it yourself with nexux_edit_file (exact text from the file, small unique pieces; all: true for a repeated string) or nexux_write_file for a new file, then say in a line or two what you changed. Do not offer to hand them text to paste, or send them to another tool, for something you can edit. Files marked secret (.env, keys, .git) cannot be read or written — say so, never ask the user to paste them. To run commands, point the user to the Terminal in the panel.",
    "",
    "# How you talk",
    "Reply in the user's language. Short, warm, plain messages; no headings. Never invent ids or paths — get them from the tools.",
    "Code goes in fenced blocks with its language (```ts, ```bash, ```pine…). When you name a file of the project, link it with its absolute path, optionally with a line: [caja.pine](/Users/…/caja.pine:42) — the app opens it in the user's editor.",
    "When the user has to decide something, ask ONE question with 2 to 5 short options as a block at the very end of your reply:",
    "",
    "```choices",
    '{"question": "Which repositories belong to the project?", "options": ["All of them", "Only api and web"]}',
    "```",
    "",
    "The app shows the options as buttons and adds a \"Something else\" choice by itself, so never add an \"other\" option. Put the question only in the block. When the user picks one, its text comes back as their message.",
    `When you need something typed (a folder path, a URL), end your reply with a final line starting exactly with "${NEEDS_INPUT_MARKER}" followed by the question.`,
  ].join("\n");
}

/** The CLI arguments for one message. Pure, for tests: the isolation lives here. */
export function nexusClaudeArgs(opts: {
  /** The message; null when it goes on stdin as stream-json (it carries images or PDFs). */
  prompt: string | null;
  systemPrompt: string;
  mcpConfig: string;
  allowedTools: string[];
  resume?: string | null;
  model?: string | null;
  effort?: string | null;
}): string[] {
  return [
    "-p",
    ...(opts.prompt === null ? ["--input-format", "stream-json"] : [opts.prompt]),
    // Streamed, partial messages included: the reply shows in the chat as it
    // is written, and the tools it calls show as steps. The last line is
    // still the result event parseClaudeOutput reads.
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
    // Nothing built in: no Bash, no Read/Edit/Write, no web. Only the MCP tools below.
    "--tools",
    "",
    "--strict-mcp-config",
    "--mcp-config",
    opts.mcpConfig,
    "--allowedTools",
    opts.allowedTools.join(","),
    "--disable-slash-commands",
    // Not the user's settings or hooks: only a local settings file, and the
    // run's folder has none.
    "--setting-sources",
    "local",
    "--append-system-prompt",
    opts.systemPrompt,
    ...(opts.model ? ["--model", opts.model] : []),
    ...(opts.effort && ["low", "medium", "high", "xhigh", "max"].includes(opts.effort) ? ["--effort", opts.effort] : []),
    ...(opts.resume ? ["--resume", opts.resume] : []),
  ];
}

async function runClaude(opts: {
  runId: string;
  botId: string;
  prompt: string;
  resume: string | null;
  token: string;
  project: { id: string; name: string } | null;
  claudeCredentialId: string | null;
  model: string | null;
  effort: string | null;
}): Promise<RunOutcome> {
  const claude = await resolveClaudeCodeToken(opts.claudeCredentialId);
  if (!claude) {
    return { ok: false, error: NO_CLAUDE_TOKEN };
  }
  const port = process.env.PORT || "3000";
  const mcpConfig = JSON.stringify({
    mcpServers: {
      nexus: {
        type: "http",
        url: `http://127.0.0.1:${port}/api/mcp`,
        headers: { Authorization: `Bearer ${opts.token}` },
      },
    },
  });
  const allowedTools = toolsFor(NEXUS_SCOPES)
    .filter((t) => !NEXUS_TOOL_DENY.has(t.name))
    .map((t) => `mcp__nexus__${t.name}`);
  const cwd = path.join(os.tmpdir(), "nexux-nexus-chat");
  fs.mkdirSync(cwd, { recursive: true });

  // Its own environment: the subscription token, nothing that would switch it
  // to an API key or load another config.
  const env: NodeJS.ProcessEnv = { ...process.env, CLAUDE_CODE_OAUTH_TOKEN: claude.token };
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  delete env.CLAUDE_CONFIG_DIR;

  // Attachments go inside the message: the chat has no file tools to open them.
  const message = nexusMessage(opts.botId, opts.prompt);
  const args = nexusClaudeArgs({
    prompt: message.blocks ? null : message.text,
    systemPrompt: renderNexusSystemPrompt(opts.project, { fnpm: Boolean(fnpmPath()) }),
    mcpConfig,
    allowedTools,
    resume: opts.resume,
    model: opts.model,
    effort: opts.effort,
  });

  return new Promise<RunOutcome>((resolve) => {
    const child = spawn("claude", args, { cwd, env, stdio: [message.blocks ? "pipe" : "ignore", "pipe", "pipe"] });
    children.set(opts.runId, child);
    if (message.blocks && child.stdin) {
      child.stdin.end(JSON.stringify({ type: "user", message: { role: "user", content: message.blocks } }) + "\n");
    }
    let out = "";
    let err = "";
    let canceled = false;
    // Steps into the run's log (throttled), the reply so far into memory.
    let log = "";
    let logTimer: NodeJS.Timeout | null = null;
    const flushLog = () => {
      logTimer = null;
      void prisma.botRun.update({ where: { id: opts.runId }, data: { log: log.slice(-20_000) } }).catch(() => undefined);
    };
    const parser = createStreamParser(
      (line) => {
        log += line;
        logTimer ??= setTimeout(flushLog, 1000);
      },
      (draft) => setRunDraft(opts.runId, draft),
    );
    child.stdout?.on("data", (d) => {
      out += d;
      parser.handleChunk(String(d));
    });
    child.stderr?.on("data", (d) => (err += d));
    const timer = setTimeout(() => child.kill("SIGTERM"), RUN_TIMEOUT_MS);
    child.on("error", (e) => {
      clearTimeout(timer);
      children.delete(opts.runId);
      resolve({ ok: false, error: `Could not start Claude Code: ${e.message}` });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      children.delete(opts.runId);
      parser.flush();
      if (logTimer) clearTimeout(logTimer);
      if (log) flushLog();
      if (signal === "SIGTERM" || stopping.delete(opts.runId)) canceled = true;
      resolve(parseClaudeOutput(out, err, code, canceled));
    });
  });
}

/** `claude -p --output-format json` → the run's outcome. Pure, for tests. */
export function parseClaudeOutput(stdout: string, stderr: string, code: number | null, canceled = false): RunOutcome {
  if (canceled) return { ok: false, canceled: true };
  // stream-json: the outcome is the last `result` event — not simply the last
  // line, which after a stop can be any event (a "status" one read as the
  // error). Plain json output is one result object.
  const lines = stdout.trim().split("\n").filter(Boolean);
  const line =
    [...lines].reverse().find((l) => {
      try {
        const t = (JSON.parse(l) as { type?: string }).type;
        return t === "result" || t === undefined;
      } catch {
        return false;
      }
    }) ?? "";
  try {
    const j = JSON.parse(line) as {
      result?: string;
      is_error?: boolean;
      session_id?: string;
      total_cost_usd?: number;
      subtype?: string;
    };
    const ok = !j.is_error && j.subtype !== "error_during_execution" && typeof j.result === "string";
    return {
      ok,
      result: j.result,
      error: ok ? undefined : (j.result || j.subtype || "Claude Code failed"),
      sessionId: j.session_id,
      costUsd: j.total_cost_usd,
    };
  } catch {
    const tail = (stderr || stdout).trim().split("\n").slice(-3).join(" ").slice(0, 400);
    return { ok: false, error: tail || `Claude Code exited with code ${code}` };
  }
}
