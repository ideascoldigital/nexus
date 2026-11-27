// What the dashboard sees of a bot. Pure shaping, no Prisma — shared by the
// bot routes and kept free of server-only imports so it is cheap to test.

import { splitAttachments } from "@/lib/bot-attachments";
import { BOT_SCREEN, dockerHostKind, botVncUrl } from "@nexux/sandbox";
import { createHash } from "node:crypto";
import { z } from "zod";
import { handoffRun, replyRun } from "@/lib/bot-handoffs";
import { mailRun } from "@/lib/bot-mail";
import { validateBotMcpServers, type BotMcpServers } from "@/lib/bot-mcp";
import { isHandback, isIntro } from "@/lib/bot-prompts";
import { restartedRun } from "@/lib/bot-restart";
import { describeCron, routineRun, splitReply } from "@/lib/bot-routines";
import { BOT_SHAPES } from "@/lib/bot-shapes";

export const botInputSchema = z.object({
  name: z.string().trim().min(1).max(60),
  role: z.string().trim().max(200).nullish(),
  instructions: z.string().max(20_000).optional(),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .optional(),
  shape: z.enum(BOT_SHAPES).optional(),
  model: z.string().trim().max(60).nullish(),
  /** Reasoning effort, claude --effort; null = the CLI's default. */
  effort: z.enum(["low", "medium", "high", "xhigh", "max"]).nullish(),
  claudeCredentialId: z.string().nullish(),
  /**
   * Which Docker daemon its computers run on (D-85); null = this machine.
   * A computer that is already up stays where it is — the session carries its
   * own host — so a change applies to the next one.
   */
  dockerEndpointId: z.string().nullish(),
  idleMinutes: z.number().int().min(5).max(24 * 60).optional(),
  /** Its own MCP servers; null clears them. */
  mcpServers: z
    .unknown()
    .transform((v, ctx) => {
      const r = validateBotMcpServers(v);
      if (!r.ok) {
        ctx.addIssue({ code: "custom", message: `MCP servers: ${r.error}` });
        return z.NEVER;
      }
      return r.servers;
    })
    .optional(),
});

/** botInputSchema output → Prisma data: a cleared Json column is DbNull, not null. */
export function botDataFor<T extends { mcpServers?: BotMcpServers | null }>(
  data: T,
  dbNull: unknown,
): Omit<T, "mcpServers"> & { mcpServers?: unknown } {
  if (!("mcpServers" in data) || data.mcpServers === undefined) return data;
  return { ...data, mcpServers: data.mcpServers ?? dbNull };
}

export type BotSessionView = {
  id: string;
  status: string;
  error: string | null;
  /** The bare embedded screen (view-only until control is handed over), on loopback. */
  vncUrl: string | null;
  /** Full noVNC (control bar, clipboard, extra keys) for "open in a new tab". */
  vncFullUrl: string | null;
  /** What the boot is doing right now (image build step, waiting for the desktop). */
  progress: string | null;
  /** The desktop's own pixel size, which the dashboard scales its screen to. */
  screen: { width: number; height: number };
  /**
   * Which machine this computer is on (D-85) — worth showing, because it is
   * where the bot's files and sign-ins live, and on a remote daemon its screen
   * reaches the dashboard through an SSH forward.
   */
  runsOn: { kind: "local" | "remote"; label: string };
  createdAt: Date;
  stoppedAt: Date | null;
  lastActivityAt: Date;
};

/** How a computer's daemon reads in the UI: short, and never a bare "null". */
export function describeRunsOn(dockerHost: string | null | undefined): {
  kind: "local" | "remote";
  label: string;
} {
  if (!dockerHost) return { kind: "local", label: "this machine" };
  return dockerHostKind(dockerHost) === "remote"
    ? { kind: "remote", label: dockerHost.replace(/^ssh:\/\//i, "") }
    : { kind: "local", label: dockerHost.replace(/^unix:\/\//i, "") };
}

export function shapeSession(
  s: {
    id: string;
    status: string;
    error: string | null;
    vncPort: number | null;
    vncPassword: string | null;
    dockerHost?: string | null;
    createdAt: Date;
    stoppedAt: Date | null;
    lastActivityAt: Date;
  } | null,
  progress: string | null = null,
): BotSessionView | null {
  if (!s) return null;
  const live = s.status === "ready" && s.vncPort && s.vncPassword;
  return {
    id: s.id,
    status: s.status,
    error: s.error,
    vncUrl: live ? botVncUrl(s.vncPort!, s.vncPassword!) : null,
    vncFullUrl: live ? botVncUrl(s.vncPort!, s.vncPassword!, { full: true }) : null,
    progress: s.status === "starting" ? progress : null,
    screen: { width: BOT_SCREEN.width, height: BOT_SCREEN.height },
    runsOn: describeRunsOn(s.dockerHost),
    createdAt: s.createdAt,
    stoppedAt: s.stoppedAt,
    lastActivityAt: s.lastActivityAt,
  };
}

/** Last few progress lines of a running prompt, for the "working…" bubble. */
export function logTail(log: string, lines = 8): string {
  return log
    .split("\n")
    .map((l) => l.trimEnd())
    .filter(Boolean)
    .slice(-lines)
    .join("\n");
}

/** One thing the bot did on its computer, shown as a chip in the chat. */
export type BotStep = { app: string; action: string; detail: string | null };

const STEP_NAMES: Record<string, { app: string; action: string } | null> = {
  browser_navigate: { app: "Browser", action: "Opened" },
  browser_navigate_back: { app: "Browser", action: "Went back" },
  browser_click: { app: "Browser", action: "Clicked" },
  browser_type: { app: "Browser", action: "Typed into" },
  browser_fill_form: { app: "Browser", action: "Filled a form" },
  browser_select_option: { app: "Browser", action: "Picked an option in" },
  browser_press_key: { app: "Browser", action: "Pressed" },
  browser_hover: { app: "Browser", action: "Hovered" },
  browser_file_upload: { app: "Browser", action: "Uploaded a file" },
  browser_take_screenshot: { app: "Browser", action: "Took a screenshot" },
  browser_tabs: { app: "Browser", action: "Switched tabs" },
  browser_wait_for: null,
  browser_snapshot: null,
  browser_console_messages: null,
  browser_network_requests: null,
  browser_evaluate: { app: "Browser", action: "Ran a script" },
  WebSearch: { app: "Search", action: "Searched" },
  WebFetch: { app: "Web", action: "Read" },
  Bash: { app: "Terminal", action: "Ran" },
  Read: { app: "Files", action: "Read" },
  Write: { app: "Files", action: "Wrote" },
  Edit: { app: "Files", action: "Edited" },
  TodoWrite: null,
  ToolSearch: null,
};

/**
 * What the bot did, from its run log's tool lines (`[claude] <tool> <detail>`,
 * see describeEvent): browser and web actions as chips, bookkeeping tools
 * dropped, repeats collapsed, capped so a long run stays readable.
 */
export function botSteps(log: string, max = 12): BotStep[] {
  const steps: BotStep[] = [];
  for (const line of log.split("\n")) {
    const m = line.match(/^\[claude\] (\S+)(?: (.+))?$/);
    if (!m || m[1] === "session" || m[1] === "finished") continue;
    const tool = m[1]!.replace(/^mcp__.+?__/, "");
    const known = tool in STEP_NAMES ? STEP_NAMES[tool] : { app: "Tool", action: tool.replace(/_/g, " ") };
    if (!known) continue;
    const detail = m[2]?.trim() || null;
    const prev = steps.at(-1);
    if (prev && prev.app === known.app && prev.action === known.action && prev.detail === detail) continue;
    steps.push({ ...known, detail });
  }
  return steps.slice(-max);
}

/**
 * When a bot last did anything the user would notice: its latest message or
 * reply (sent, started or finished), else when it was created. The bots list
 * is sorted by it, newest first, like a chat inbox.
 */
export function botActiveAt(bot: { createdAt: Date }, last: { createdAt: Date; finishedAt: Date | null } | null): number {
  return Math.max(bot.createdAt.getTime(), last?.createdAt.getTime() ?? 0, last?.finishedAt?.getTime() ?? 0);
}

/** Newest activity first; equal ones keep the order they were hired in. */
export function byRecentActivity<T extends { activeAt: number; createdAt: Date }>(a: T, b: T): number {
  return b.activeAt - a.activeAt || a.createdAt.getTime() - b.createdAt.getTime();
}

/** The one-line preview under a bot's name in the list. */
export function botPreview(
  run: {
    prompt: string;
    status: string;
    result: string | null;
    error: string | null;
    needsInput: boolean;
  } | null,
): string | null {
  if (!run) return null;
  const clean = (t: string) =>
    t
      .replace(/NEEDS_INPUT:\s*/g, "")
      .replace(/[*_`#>[\]]/g, "")
      .replace(/\(https?:[^)]*\)/g, "")
      .replace(/\s+/g, " ")
      .trim();
  if (run.status === "running") return "Working…";
  if (run.status === "queued") {
    if (isHandback(run.prompt)) return "Checking what you did…";
    if (isIntro(run.prompt)) return "Getting ready to say hi…";
    const routine = routineRun(run.prompt);
    if (routine) return `Routine · ${routine.name}`;
    if (restartedRun(run.prompt)) return "Restarting its computer…";
    const from = handoffRun(run.prompt);
    if (from) return `${from.fromName}: ${clean(from.message)}`;
    const back = replyRun(run.prompt);
    if (back) return `${back.teammateName} replied`;
    const mail = mailRun(run.prompt);
    if (mail) return `${mail.mode === "send" ? "Sending" : "Saving draft"} · ${clean(mail.mail.subject)}`;
    const { text, attachments } = splitAttachments(run.prompt);
    const files = attachments.length ? `📎 ${attachments.length === 1 ? attachments[0]!.name : `${attachments.length} files`}` : "";
    return `You: ${[clean(text), files].filter(Boolean).join(" ")}`;
  }
  if (run.status === "error") return run.error ? `Error: ${clean(run.error)}` : "Error";
  if (run.status === "canceled") return "Stopped";
  const reply = splitReply(run.result);
  if (reply.choices) return clean(reply.choices.question);
  if (reply.body) return clean(reply.body);
  if (reply.mails.length) return reply.mails.length === 1 ? `Email to review · ${clean(reply.mails[0]!.subject)}` : `${reply.mails.length} emails to review`;
  if (reply.handoffs.length) return `Sent to ${reply.handoffs[0]!.to}`;
  if (reply.routines.length) return `Updated routine · ${reply.routines[0]!.name}`;
  return "Done";
}

export function shapeRun<
  R extends { status: string; log: string },
>(run: R): Omit<R, "log"> & { logTail: string | null; steps: BotStep[] } {
  const { log, ...rest } = run;
  return {
    ...rest,
    logTail: run.status === "running" ? logTail(log) || null : null,
    steps: botSteps(log),
  };
}

/** idle | thinking | starting | off | error — the dot next to a bot's name. */
export function botActivity(
  session: { status: string } | null,
  pendingRuns: number,
): "off" | "starting" | "idle" | "working" | "error" {
  if (!session) return "off";
  if (session.status === "starting") return "starting";
  if (session.status === "ready") return pendingRuns > 0 ? "working" : "idle";
  if (session.status === "error") return "error";
  return "off";
}

/**
 * Fold a chunk of `docker build` output (BuildKit's plain progress, which it
 * uses whenever stdout is not a TTY) into one human line: the current step and
 * its latest output, e.g. "Building the computer image · step 2/6 · Get:187 …".
 */
export function buildProgress(prev: { step: string | null; line: string | null }, chunk: string) {
  let { step, line } = prev;
  for (const raw of chunk.split(/\r?\n/)) {
    const m = raw.match(/^#\d+\s+(?:\d+\.\d+\s+)?(.*)$/);
    const text = (m ? m[1]! : raw).trim();
    if (!text) continue;
    const s = text.match(/^\[(\d+\/\d+)\]/);
    if (s) {
      step = s[1]!;
      line = null;
      continue;
    }
    if (/^(DONE|CACHED)\b/.test(text) || text.startsWith("[internal]")) continue;
    line = text.length > 120 ? `${text.slice(0, 117)}…` : text;
  }
  return { step, line };
}

export function formatBuildProgress(p: { step: string | null; line: string | null }): string {
  return ["Building the computer image (first run only)", p.step && `step ${p.step}`, p.line]
    .filter(Boolean)
    .join(" · ");
}

/**
 * A new computer starts with a fresh Claude (its memory lived in the old
 * container), so its first prompt carries the recent conversation: the bot
 * knows what "try again" refers to, and that pages and sign-ins are gone.
 */
export function withEarlierContext(
  prompt: string,
  history: { prompt: string; result: string | null }[],
  perAnswer = 700,
  /**
   * "computer": a new machine. "memory": same machine, fresh Claude session
   * (instructions changed). "cleared": the user cleared the conversation's
   * context (spec 37) — the machine is untouched, and whatever is replayed
   * here happened after that moment.
   */
  reason: "computer" | "memory" | "cleared" = "computer",
): string {
  if (history.length === 0) return prompt;
  const lines = history.map((h) => {
    const asked = isHandback(h.prompt)
      ? "(The user took control of your computer, then handed it back.)"
      : isIntro(h.prompt)
        ? "(You introduced yourself.)"
        : routineRun(h.prompt)
          ? `(Your routine "${routineRun(h.prompt)!.name}" ran.)`
          : handoffRun(h.prompt)
            ? `Your teammate ${handoffRun(h.prompt)!.fromName} wrote: ${handoffRun(h.prompt)!.message}`
            : replyRun(h.prompt)
              ? `Your teammate ${replyRun(h.prompt)!.teammateName} answered: ${replyRun(h.prompt)!.answer}`
              : mailRun(h.prompt)
                ? `(The user approved your email "${mailRun(h.prompt)!.mail.subject}" to ${mailRun(h.prompt)!.mail.to} and asked you to ${mailRun(h.prompt)!.mode === "send" ? "send it" : "save it as a Gmail draft"}.)`
                : `The user asked: ${h.prompt.trim()}`;
    const answer = (h.result ?? "").trim();
    const short = answer.length > perAnswer ? `${answer.slice(0, perAnswer)}…` : answer;
    return short ? `${asked}\nYou answered: ${short}` : asked;
  });
  const note =
    reason === "memory"
      ? "Note: your instructions were updated, so this is a fresh conversation on the same computer — your files, open pages and sign-ins are still there. Earlier conversation, oldest first:"
      : reason === "cleared"
        ? "Note: the user cleared this conversation, so you remember nothing of what came before it. Your computer is untouched — your files, open pages and sign-ins are still there. What has been said since they cleared it, oldest first:"
        : "Note: your computer was reset since your last messages. It is a fresh machine: nothing is open and you are not signed in anywhere. Earlier conversation, oldest first:";
  return [
    note,
    "",
    lines.join("\n\n"),
    "",
    "---",
    "New message from the user:",
    prompt,
  ].join("\n");
}

export const routineInputSchema = z.object({
  name: z.string().trim().min(1).max(120),
  prompt: z.string().trim().min(1).max(10_000),
  cron: z.string().trim().min(9).max(120),
  enabled: z.boolean().optional(),
});

/** A routine as the panel shows it: its schedule in words. */
export function shapeRoutine<R extends { cron: string }>(r: R): R & { label: string } {
  return { ...r, label: describeCron(r.cron) };
}

/**
 * Links to the user's own machine, as the bot's container can reach them:
 * inside it `localhost` is the container, the host is host.docker.internal.
 * Applied to prompts on their way to the bot; the chat keeps the original.
 *
 * `base` is Nexus as that computer reaches it (D-88). It differs from
 * host.docker.internal only for a bot on another machine's daemon, where
 * Nexus answers on a return tunnel's port rather than its own — so a link to
 * Nexus needs the whole origin replaced, not just the hostname. Links to
 * other ports keep the plain swap: they point at something on this machine
 * that a remote computer has no route to either way, and silently sending
 * them to Nexus instead would be worse than leaving them unreachable.
 */
export function toContainerUrls(text: string, base?: string): string {
  const nexusPort = process.env.PORT || "3000";
  return text.replace(
    /\b(https?:\/\/)(?:localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)(?::(\d+))?\b/gi,
    (_whole, scheme: string, port: string | undefined) =>
      base && port === nexusPort ? base : `${scheme}host.docker.internal${port ? `:${port}` : ""}`,
  );
}

/** Nexus's own URL from inside a bot's container. */
export function hostAppUrl(port = process.env.PORT || "3000"): string {
  return `http://host.docker.internal:${port}`;
}

/**
 * The bot's routines as a short note on each message. They change often, so
 * they ride with the message rather than in the system prompt (a system
 * prompt change starts a fresh Claude session).
 */
export function withRoutinesNote(
  prompt: string,
  routines: { name: string; cron: string; enabled: boolean }[],
): string {
  if (routines.length === 0) return prompt;
  const list = routines
    .map((r) => `"${r.name}" (${describeCron(r.cron)}, \`${r.cron}\`${r.enabled ? "" : ", paused"})`)
    .join("; ");
  return `[Nexus: your routines now — ${list}]\n\n${prompt}`;
}

/** Short stable hash of a system prompt, to notice when it changed. */
export function promptHash(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

/**
 * Nexus-relative links (files bots handed over: /api/bots/…/files/…) made
 * absolute for a bot's container, so a teammate can download them.
 */
export function absolutizeNexusLinks(text: string, base = hostAppUrl()): string {
  return text.replace(/\]\((\/api\/bots\/[^)\s]+)\)/g, (_, path: string) => `](${base}${path})`);
}

/** A teammate's side of a handoff, threaded under the sender's message. */
export type ThreadReply = {
  id: string;
  /** The teammate that got the handoff. */
  botId: string;
  /** The sender's run the handoff came from. */
  sourceRunId: string;
  status: string;
  /** The teammate's reply, as the chat shows it (no blocks), when done. */
  text: string | null;
  error: string | null;
  createdAt: Date;
  finishedAt: Date | null;
};

export function shapeThreadReply(r: {
  id: string;
  botId: string;
  prompt: string;
  status: string;
  result: string | null;
  error: string | null;
  createdAt: Date;
  finishedAt: Date | null;
}): ThreadReply[] {
  const h = handoffRun(r.prompt);
  if (!h?.sourceRunId) return [];
  const reply = splitReply(r.result);
  const text = reply.body || (reply.choices ? reply.choices.question : null);
  return [
    {
      id: r.id,
      botId: r.botId,
      sourceRunId: h.sourceRunId,
      status: r.status,
      text: r.status === "completed" ? text : null,
      error: r.status === "error" ? r.error : null,
      createdAt: r.createdAt,
      finishedAt: r.finishedAt,
    },
  ];
}
