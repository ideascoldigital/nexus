// Bots (spec 31): AI teammates, each with its own ephemeral computer.
//
// A session is one container: started on the first prompt (or by hand),
// deleted when the user ends it or after `idleMinutes` without a prompt.
// Prompts queue per session and run strictly in order, each one resuming the
// session's Claude conversation. Everything runs in-process, like the dev
// console: the workers and abort handles live on globalThis so they survive
// HMR, and `recoverBots` settles what a previous process left behind.

import { randomBytes } from "crypto";
import { prisma, type BotSession } from "@nexux/db";
import {
  botReadiness,
  dockerAvailable,
  launchBotContainer,
  listBotContainers,
  renderBotSystemPrompt,
  runBotPrompt,
  writeBotMcpConfig,
  stopBotClaudeRuns,
  stopBotContainer,
} from "@nexux/sandbox";
import { detectNeedsInput, NEEDS_INPUT_MARKER } from "@/lib/agent-core";
import { parseChoices } from "@/lib/bot-choices";
import { collectBotFiles } from "@/lib/bot-files";
import { botMounts, botWorkdir, workspaceFolderFor } from "@/lib/bot-workspace";
import { seedComputer, shareFromComputer } from "@/lib/team-cookies";
import {
  findTeammate,
  handoffForClaude,
  handoffRun,
  MAX_HANDOFF_HOPS,
  parseHandoffBlocks,
  renderHandoffPrompt,
  renderReplyPrompt,
  replyForClaude,
  replyRun,
} from "@/lib/bot-handoffs";
import { mailForClaude, mailRun } from "@/lib/bot-mail";
import { validateBotMcpServers } from "@/lib/bot-mcp";
import { applyRoutineSpecs, hostTimezone, nextRoutineRun } from "@/lib/bot-routine-store";
import { describeCron, parseRoutineBlocks, renderRoutinePrompt, splitReply } from "@/lib/bot-routines";
import {
  absolutizeNexusLinks,
  buildProgress,
  formatBuildProgress,
  hostAppUrl,
  promptHash,
  toContainerUrls,
  withEarlierContext,
  withRoutinesNote,
} from "@/lib/bot-view";
import { resolveClaudeCodeToken } from "@/lib/sandbox-manager";

export const ACTIVE_SESSION_STATUSES = ["starting", "ready"] as const;
const READY_TIMEOUT_MS = 3 * 60_000;
const READY_POLL_MS = 1500;
const RUN_TIMEOUT_MS = 45 * 60_000;
const REAPER_INTERVAL_MS = 60_000;
const LOG_LIMIT = 40_000;

const g = globalThis as unknown as {
  nexuxBotWorkers?: Set<string>;
  nexuxBotAborts?: Map<string, AbortController>;
  nexuxBotReaper?: NodeJS.Timeout;
  nexuxBotBootProgress?: Map<string, string>;
};
/** One drain loop per session. */
const workers = (g.nexuxBotWorkers ??= new Set<string>());
/** Abort handle per running run — the stop button and session end use it. */
const aborts = (g.nexuxBotAborts ??= new Map<string, AbortController>());
/** Latest boot progress line per starting session — shown on the computer pane. */
const bootProgress = (g.nexuxBotBootProgress ??= new Map<string, string>());

export function botBootProgress(sessionId: string): string | null {
  return bootProgress.get(sessionId) ?? null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function botContainerName(botId: string): string {
  return `nexux-bot-${botId.slice(-8)}-${randomBytes(3).toString("hex")}`;
}

export async function activeSession(botId: string): Promise<BotSession | null> {
  return prisma.botSession.findFirst({
    where: { botId, status: { in: [...ACTIVE_SESSION_STATUSES] } },
    orderBy: { createdAt: "desc" },
  });
}

// ---- Session lifecycle ----------------------------------------------------------

/**
 * The bot's running session, or a new one. Returns at once: the container
 * boots in the background and the session flips to `ready` (or `error`).
 */
export async function startBotSession(botId: string): Promise<BotSession> {
  const existing = await activeSession(botId);
  if (existing) return existing;

  const bot = await prisma.bot.findUnique({ where: { id: botId } });
  if (!bot) throw new Error("Bot not found");
  if (!(await dockerAvailable())) {
    throw new Error("Docker is not running — bots need it to start their computer");
  }
  const claude = await resolveClaudeCodeToken(bot.claudeCredentialId);
  if (!claude) {
    throw new Error(
      "No Claude Code token — add one in Settings → AI Providers (`claude setup-token`)",
    );
  }

  const session = await prisma.botSession.create({
    data: {
      botId,
      status: "starting",
      containerName: botContainerName(botId),
      vncPassword: randomBytes(6).toString("hex"),
    },
  });
  void bootSession(session.id, claude.token);
  return session;
}

async function bootSession(sessionId: string, claudeToken: string): Promise<void> {
  const session = await prisma.botSession.findUnique({ where: { id: sessionId }, include: { bot: true } });
  if (!session) return;
  let build = { step: null as string | null, line: null as string | null };
  bootProgress.set(sessionId, "Preparing the computer…");
  try {
    const { vncPort } = await launchBotContainer({
      name: session.containerName,
      env: {
        CLAUDE_CODE_OAUTH_TOKEN: claudeToken,
        VNC_PASSWORD: session.vncPassword ?? "",
      },
      // The shared workspace and its browser profile outlive the computer.
      mounts: botMounts(session.bot),
      onLog: (chunk) => {
        build = buildProgress(build, chunk);
        if (build.step || build.line) bootProgress.set(sessionId, formatBuildProgress(build));
      },
    });
    await prisma.botSession.update({ where: { id: sessionId }, data: { vncPort } });
    bootProgress.set(sessionId, "Waiting for the desktop and Chromium to come up…");

    const deadline = Date.now() + READY_TIMEOUT_MS;
    for (;;) {
      // Ended by the user while booting: the stop path already cleaned up.
      const current = await prisma.botSession.findUnique({ where: { id: sessionId } });
      if (!current || current.status !== "starting") {
        await stopBotContainer(session.containerName);
        return;
      }
      const state = await botReadiness(session.containerName);
      if (state === "ready") break;
      if (typeof state === "object") throw new Error(state.failed);
      if (Date.now() > deadline) throw new Error("the desktop did not come up in 3 minutes");
      await sleep(READY_POLL_MS);
    }

    // The team's sign-ins, before the first task runs.
    bootProgress.set(sessionId, "Signing in like the rest of the team…");
    await seedComputer(session.botId, session.containerName).catch((err) =>
      console.warn("[bots] could not seed sign-ins:", err instanceof Error ? err.message : err),
    );
    await prisma.botSession.update({
      where: { id: sessionId },
      data: { status: "ready", lastActivityAt: new Date() },
    });
    kickBotWorker(sessionId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await stopBotContainer(session.containerName);
    await endSession(sessionId, "error", `Could not start the computer: ${message}`);
  } finally {
    bootProgress.delete(sessionId);
  }
}

/**
 * You are on the computer (its screen is open in the dashboard): that is
 * activity, so the idle reaper leaves it alone. Called as a heartbeat.
 */
export async function touchBotSession(botId: string): Promise<boolean> {
  const touched = await prisma.botSession.updateMany({
    where: { botId, status: { in: [...ACTIVE_SESSION_STATUSES] } },
    data: { lastActivityAt: new Date() },
  });
  // You may be signing in by hand right now: share it without waiting for a task.
  const last = lastShare.get(botId) ?? 0;
  if (touched.count > 0 && Date.now() - last > SHARE_EVERY_MS) {
    lastShare.set(botId, Date.now());
    const s = await prisma.botSession.findFirst({ where: { botId, status: "ready" } });
    if (s) void shareSignIns(botId, s.containerName);
  }
  return touched.count > 0;
}

const SHARE_EVERY_MS = 30_000;
const lastShare = ((globalThis as unknown as { nexuxLastShare?: Map<string, number> }).nexuxLastShare ??= new Map());

/**
 * Shared sign-ins (team-cookies.ts): take what changed in this computer's
 * browser to the team and to every other awake computer. Best effort — a
 * failure never stops a bot.
 */
export async function shareSignIns(botId: string, container: string): Promise<void> {
  try {
    const others = await prisma.botSession.findMany({
      where: { status: "ready", botId: { not: botId } },
      select: { botId: true, containerName: true },
    });
    await shareFromComputer(
      botId,
      container,
      others.map((o) => ({ botId: o.botId, container: o.containerName })),
    );
  } catch (err) {
    console.warn("[bots] could not share sign-ins:", err instanceof Error ? err.message : err);
  }
}

/** Settle a session and everything still pending on it. */
async function endSession(
  sessionId: string,
  status: "stopped" | "error",
  error?: string,
): Promise<void> {
  const now = new Date();
  await prisma.botSession.updateMany({
    where: { id: sessionId, status: { in: [...ACTIVE_SESSION_STATUSES] } },
    data: { status, error: error ?? null, stoppedAt: now },
  });
  await prisma.botRun.updateMany({
    where: { sessionId, status: { in: ["queued", "running"] } },
    data: {
      status: status === "error" ? "error" : "canceled",
      error: status === "error" ? (error ?? "The session failed") : null,
      finishedAt: now,
    },
  });
}

/** Delete the bot's computer. Anything queued or running is canceled. */
export async function stopBotSession(botId: string): Promise<void> {
  const sessions = await prisma.botSession.findMany({
    where: { botId, status: { in: [...ACTIVE_SESSION_STATUSES] } },
  });
  for (const s of sessions) {
    // Last chance to keep what was signed into on this computer.
    if (s.status === "ready") await shareSignIns(botId, s.containerName);
    // Settle first so the worker and the booter both see the session gone.
    await endSession(s.id, "stopped");
    const running = await prisma.botRun.findMany({
      where: { sessionId: s.id },
      select: { id: true },
    });
    for (const r of running) aborts.get(r.id)?.abort();
    await stopBotContainer(s.containerName);
  }
}

// ---- Prompts --------------------------------------------------------------------

/** Queue a prompt; boots the computer first when the bot has none running. */
export async function enqueueBotPrompt(botId: string, prompt: string) {
  const session = await startBotSession(botId);
  const run = await prisma.botRun.create({
    data: { botId, sessionId: session.id, prompt, status: "queued" },
  });
  await prisma.botSession.update({
    where: { id: session.id },
    data: { lastActivityAt: new Date() },
  });
  if (session.status === "ready") kickBotWorker(session.id);
  return run;
}

/** Cancel a queued prompt or stop a running one. */
export async function cancelBotRun(botId: string, runId: string): Promise<boolean> {
  const run = await prisma.botRun.findFirst({ where: { id: runId, botId } });
  if (!run) return false;
  if (run.status === "queued") {
    await prisma.botRun.updateMany({
      where: { id: runId, status: "queued" },
      data: { status: "canceled", finishedAt: new Date() },
    });
    return true;
  }
  if (run.status === "running") {
    aborts.get(runId)?.abort();
    return true;
  }
  return false;
}

export function kickBotWorker(sessionId: string): void {
  if (workers.has(sessionId)) return;
  workers.add(sessionId);
  void drain(sessionId).finally(() => workers.delete(sessionId));
}

async function drain(sessionId: string): Promise<void> {
  for (;;) {
    const session = await prisma.botSession.findUnique({
      where: { id: sessionId },
      include: { bot: true },
    });
    if (!session || session.status !== "ready") return;
    const run = await prisma.botRun.findFirst({
      where: { sessionId, status: "queued" },
      orderBy: { createdAt: "asc" },
    });
    if (!run) return;

    const claimed = await prisma.botRun.updateMany({
      where: { id: run.id, status: "queued" },
      data: { status: "running", startedAt: new Date() },
    });
    if (claimed.count === 0) continue;

    // Claude Code keeps a session's first system prompt on --resume, so when
    // the instructions changed (an edit in Settings, a Nexus update) the bot
    // starts a fresh Claude session — on the same computer — instead.
    const team = await prisma.bot.findMany({
      where: { id: { not: session.botId } },
      orderBy: { createdAt: "asc" },
      select: { name: true, role: true },
    });
    // Its own MCP servers, as saved (validated on save; re-checked in case of hand edits).
    const own = validateBotMcpServers(session.bot.mcpServers);
    const mcpServers = own.ok ? own.servers : null;
    const systemPrompt = renderBotSystemPrompt({
      name: session.bot.name,
      role: session.bot.role,
      instructions: session.bot.instructions,
      needsInputMarker: NEEDS_INPUT_MARKER,
      timezone: hostTimezone(),
      hostAppUrl: hostAppUrl(),
      teammates: team,
      workspaceFolder: workspaceFolderFor(session.bot.name),
      mcpServers: mcpServers ? Object.keys(mcpServers) : [],
    });
    const sysHash = promptHash(systemPrompt);
    const resume =
      session.claudeSessionId && session.systemPromptHash === sysHash ? session.claudeSessionId : null;

    // A fresh Claude session (new computer, or new instructions): hand it the recent chat.
    let prompt = run.prompt;
    if (!resume) {
      const history = await prisma.botRun.findMany({
        where: { botId: session.botId, status: "completed", id: { not: run.id } },
        orderBy: { createdAt: "desc" },
        take: 6,
        select: { prompt: true, result: true },
      });
      prompt = withEarlierContext(
        run.prompt,
        history.reverse().map((h) => ({ ...h, prompt: toContainerUrls(h.prompt) })),
        700,
        session.claudeSessionId ? "memory" : "computer",
      );
    }
    prompt = withRoutinesNote(
      prompt,
      await prisma.botRoutine.findMany({
        where: { botId: session.botId },
        orderBy: { createdAt: "asc" },
        select: { name: true, cron: true, enabled: true },
      }),
    );

    // A teammate's message reads as one (not as the user), and files it
    // handed over are downloadable from the container.
    const incoming = handoffRun(run.prompt);
    if (incoming) prompt = prompt.replace(run.prompt, handoffForClaude(incoming));
    // A teammate's answer to something this bot asked for: continue the task.
    const answer = replyRun(run.prompt);
    if (answer) prompt = prompt.replace(run.prompt, replyForClaude(answer));
    // The user approved an email on its card: send (or save) it as written.
    const mail = mailRun(run.prompt);
    if (mail) prompt = prompt.replace(run.prompt, mailForClaude(mail));
    // Links to the user's machine, reachable from the container.
    prompt = absolutizeNexusLinks(toContainerUrls(prompt));

    const abort = new AbortController();
    aborts.set(run.id, abort);
    const log = createRunLog(run.id);
    try {
      // Rewritten every prompt, so a settings change applies on the next message.
      let userMcp = false;
      try {
        await writeBotMcpConfig(session.containerName, mcpServers);
        userMcp = Boolean(mcpServers);
      } catch (err) {
        console.warn(`[bots] ${session.bot.name}: MCP servers not loaded:`, err instanceof Error ? err.message : err);
      }
      const result = await runBotPrompt(prompt, {
        container: session.containerName,
        systemPrompt,
        resumeSessionId: resume,
        model: session.bot.model,
        userMcp,
        cwd: botWorkdir(session.bot.name),
        onLog: log.sink,
        timeoutMs: RUN_TIMEOUT_MS,
        signal: abort.signal,
      });
      await log.close();
      // Files the reply hands over (outbox://…) come out of the computer now,
      // while it still exists, and the reply points at Nexus's copies.
      if (result.ok && result.result && !abort.signal.aborted) {
        result.result = await collectBotFiles({
          botId: session.botId,
          runId: run.id,
          container: session.containerName,
          text: result.result,
        }).catch((err) => {
          console.warn("[bots] could not collect files:", err instanceof Error ? err.message : err);
          return result.result!;
        });
      }
      const now = new Date();
      if (abort.signal.aborted) {
        await prisma.botRun.updateMany({
          where: { id: run.id, status: "running" },
          data: { status: "canceled", finishedAt: now },
        });
      } else {
        await prisma.botRun.updateMany({
          where: { id: run.id, status: "running" },
          data: {
            status: result.ok ? "completed" : "error",
            result: result.result ?? null,
            needsInput: result.ok && (detectNeedsInput(result.result) || parseChoices(result.result) !== null),
            error: result.ok ? null : (result.error ?? "The run failed"),
            costUsd: result.costUsd ?? null,
            durationMs: result.durationMs ?? null,
            finishedAt: now,
          },
        });
      }
      // The reply may message teammates and create, change or remove routines.
      if (result.ok && !abort.signal.aborted) {
        const hop = (incoming?.hop ?? answer?.hop ?? 0) + 1;
        await deliverHandoffs({
          fromId: session.botId,
          fromName: session.bot.name,
          hop,
          sourceRunId: run.id,
          text: result.result ?? "",
        }).catch((err) => console.warn("[bots] handoff failed:", err instanceof Error ? err.message : err));
        // The sender asked for this answer back: hand it over so it can continue.
        if (incoming?.wantsReply && hop <= MAX_HANDOFF_HOPS) {
          const shown = splitReply(result.result);
          await enqueueBotPrompt(
            incoming.fromId,
            renderReplyPrompt({
              teammateId: session.botId,
              teammateName: session.bot.name,
              hop,
              answer: shown.body || shown.choices?.question || "(no text)",
            }),
          ).catch((err) => console.warn("[bots] reply back failed:", err instanceof Error ? err.message : err));
        }
        const specs = parseRoutineBlocks(result.result).routines;
        if (specs.length) {
          const changes = await applyRoutineSpecs(session.botId, specs);
          for (const c of changes.filter((c) => c.action === "rejected")) {
            console.warn(`[bots] routine "${c.name}" rejected: ${c.reason}`);
          }
        }
      }
      await prisma.botSession.updateMany({
        where: { id: sessionId, status: "ready" },
        data: {
          lastActivityAt: now,
          ...(result.sessionId ? { claudeSessionId: result.sessionId, systemPromptHash: sysHash } : {}),
        },
      });
    } catch (err) {
      await log.close();
      await prisma.botRun.updateMany({
        where: { id: run.id, status: "running" },
        data: {
          status: "error",
          error: err instanceof Error ? err.message : String(err),
          finishedAt: new Date(),
        },
      });
    } finally {
      aborts.delete(run.id);
    }
    // Anything it signed into (or out of) during the task reaches the team.
    await shareSignIns(session.botId, session.containerName);
  }
}

/** Throttled live log: one DB write per second at most, tail-capped. */
function createRunLog(runId: string) {
  let full = "";
  let timer: NodeJS.Timeout | null = null;
  let writing = Promise.resolve();
  const flush = () => {
    timer = null;
    const snapshot = full;
    writing = writing.then(() =>
      prisma.botRun
        .update({ where: { id: runId }, data: { log: snapshot } })
        .then(() => undefined)
        .catch(() => undefined),
    );
  };
  return {
    sink(chunk: string) {
      full = (full + chunk).slice(-LOG_LIMIT);
      if (!timer) timer = setTimeout(flush, 1000);
    },
    async close() {
      if (timer) clearTimeout(timer);
      flush();
      await writing;
    },
  };
}

// ---- Teammates ---------------------------------------------------------------------

/**
 * Queue each handoff in a reply on the teammate it names. Unknown names and
 * chains past MAX_HANDOFF_HOPS are dropped (logged) — the sender's chat still
 * shows the attempt, so the user can see what happened.
 */
export async function deliverHandoffs(opts: {
  fromId: string;
  fromName: string;
  hop: number;
  /** The sender's run that wrote the handoffs: replies thread under it. */
  sourceRunId?: string;
  text: string;
}): Promise<number> {
  const { handoffs } = parseHandoffBlocks(opts.text);
  if (handoffs.length === 0) return 0;
  if (opts.hop > MAX_HANDOFF_HOPS) {
    console.warn(`[bots] ${opts.fromName}: handoff chain past ${MAX_HANDOFF_HOPS} hops, not delivered`);
    return 0;
  }
  const team = await prisma.bot.findMany({ where: { id: { not: opts.fromId } }, select: { id: true, name: true } });
  let sent = 0;
  for (const h of handoffs) {
    const to = findTeammate(team, h.to);
    if (!to) {
      console.warn(`[bots] ${opts.fromName}: no teammate named "${h.to}"`);
      continue;
    }
    await enqueueBotPrompt(
      to.id,
      renderHandoffPrompt({
        fromId: opts.fromId,
        fromName: opts.fromName,
        hop: opts.hop,
        sourceRunId: opts.sourceRunId,
        wantsReply: h.reply,
        message: h.message,
      }),
    );
    sent++;
  }
  return sent;
}

// ---- Routines ------------------------------------------------------------------------

/**
 * Fire routines whose time has come: queue their prompt (waking the computer)
 * and schedule the next one. A routine still queued or running from its last
 * firing is skipped, so a slow one never piles up. A firing missed while
 * Nexux was off happens once, at the next tick.
 */
export async function fireDueRoutines(now = new Date()): Promise<number> {
  const due = await prisma.botRoutine.findMany({
    where: { enabled: true, nextRunAt: { lte: now } },
  });
  let fired = 0;
  for (const r of due) {
    const pending = await prisma.botRun.count({
      where: {
        botId: r.botId,
        status: { in: ["queued", "running"] },
        prompt: { startsWith: `[nexux:routine:${r.id}]` },
      },
    });
    await prisma.botRoutine.update({
      where: { id: r.id },
      data: { nextRunAt: nextRoutineRun(r.cron, now), ...(pending ? {} : { lastRunAt: now }) },
    });
    if (pending) continue;
    try {
      await enqueueBotPrompt(r.botId, renderRoutinePrompt({ ...r, label: describeCron(r.cron) }));
      fired++;
    } catch (err) {
      console.error(`[bots] routine "${r.name}" could not start:`, err instanceof Error ? err.message : err);
    }
  }
  return fired;
}

// ---- Idle reaping + recovery -------------------------------------------------------

/** Sessions with nothing pending and no prompt for `idleMinutes`. */
export function isIdleExpired(
  session: { lastActivityAt: Date },
  idleMinutes: number,
  pending: number,
  now = Date.now(),
): boolean {
  if (pending > 0) return false;
  return now - session.lastActivityAt.getTime() > Math.max(1, idleMinutes) * 60_000;
}

export async function reapIdleBots(): Promise<number> {
  const sessions = await prisma.botSession.findMany({
    where: { status: "ready" },
    include: {
      bot: { select: { idleMinutes: true } },
      _count: { select: { runs: { where: { status: { in: ["queued", "running"] } } } } },
    },
  });
  let reaped = 0;
  for (const s of sessions) {
    if (isIdleExpired(s, s.bot.idleMinutes, s._count.runs)) {
      await stopBotSession(s.botId);
      reaped++;
    }
  }
  return reaped;
}

/**
 * What a restart does with the computers it finds: a `ready` session whose
 * container is still there is adopted (it keeps its browser, sign-ins and
 * Claude memory); every other active session ends; containers nobody adopts
 * are deleted. Pure, so the decision is testable without Docker.
 */
export function planRecovery(
  sessions: { id: string; status: string; containerName: string }[],
  containers: string[],
): { adopt: string[]; end: string[]; remove: string[] } {
  const present = new Set(containers);
  const adopt = sessions.filter((s) => s.status === "ready" && present.has(s.containerName));
  const kept = new Set(adopt.map((s) => s.containerName));
  return {
    adopt: adopt.map((s) => s.id),
    end: sessions.filter((s) => !adopt.includes(s)).map((s) => s.id),
    remove: containers.filter((c) => !kept.has(c)),
  };
}

/**
 * Boot hook. Computers that survived the restart are adopted rather than
 * deleted — deleting them threw away sign-ins the user had just done. Only
 * the runs that were mid-flight are lost (their supervisor was the old
 * process): they are marked failed and their Claude processes killed.
 * Then start the minute tick.
 */
export async function recoverBots(): Promise<void> {
  const sessions = await prisma.botSession.findMany({
    where: { status: { in: [...ACTIVE_SESSION_STATUSES] } },
    select: { id: true, status: true, containerName: true },
  });
  const plan = planRecovery(sessions, await listBotContainers());
  const now = new Date();
  for (const id of plan.adopt) {
    const s = sessions.find((x) => x.id === id)!;
    if ((await botReadiness(s.containerName)) !== "ready") {
      await stopBotContainer(s.containerName);
      await endSession(id, "stopped", "Nexux restarted — the computer was deleted");
      continue;
    }
    await stopBotClaudeRuns(s.containerName);
    await prisma.botRun.updateMany({
      where: { sessionId: id, status: "running" },
      data: { status: "error", error: "Nexux restarted while this was running. Ask again.", finishedAt: now },
    });
    // A fresh idle window, and pick up anything still queued.
    await prisma.botSession.update({ where: { id }, data: { lastActivityAt: now } });
    kickBotWorker(id);
  }
  for (const id of plan.end) {
    await endSession(id, "stopped", "Nexux restarted — the computer was deleted");
  }
  for (const name of plan.remove) {
    await stopBotContainer(name);
  }
  if (!g.nexuxBotReaper) {
    // One tick a minute: put idle computers to sleep, wake bots whose
    // routines are due ("around 8:00 AM" — at most a minute late).
    g.nexuxBotReaper = setInterval(() => {
      reapIdleBots().catch((err) => console.error("[bots] idle reaper failed:", err));
      fireDueRoutines().catch((err) => console.error("[bots] routine tick failed:", err));
    }, REAPER_INTERVAL_MS);
    g.nexuxBotReaper.unref?.();
  }
}
