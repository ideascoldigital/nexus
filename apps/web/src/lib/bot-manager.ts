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
  dockerHostKind,
  probeDockerEndpoint,
  launchBotContainer,
  listBotContainers,
  renderBotSystemPrompt,
  runBotPrompt,
  botScreenPort,
  botCalendarMcpServer,
  botGmailMcpServer,
  botVaultMcpServer,
  writeBotCalendarScript,
  writeBotGmailScript,
  writeBotVaultScripts,
  writeBotMcpConfig,
  stopBotClaudeRuns,
  stopBotContainer,
} from "@nexux/sandbox";
import { detectNeedsInput, NEEDS_INPUT_MARKER } from "@/lib/agent-core";
import { parseChoices } from "@/lib/bot-choices";
import { collectBotFiles } from "@/lib/bot-files";
import { deliverAttachments } from "@/lib/bot-uploads";
import { connectorServersFor } from "@/services/connector-store";
import { probeColumns } from "@/lib/docker-endpoints";
import { botNexusUrl, closeNexusReach } from "@/lib/bot-nexus-reach";
import { botScreenLocalPort, closeBotScreenForward } from "@/lib/bot-screen";
import { botMounts, botVolumes, botWorkdir, workspaceFolderFor } from "@/lib/bot-workspace";
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
import { grantVault, revokeVault } from "@/lib/bot-vault-access";
import { googleAccountsFor } from "@/services/google";
import { botMayUse, FILLABLE, resolveSecretRefs, type VaultType } from "@/lib/vault-items";
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

/**
 * Which daemon a bot's computers run on, and what to call it when something
 * goes wrong there. Read once per launch and copied onto the session, so every
 * path afterwards works from the row rather than re-joining (D-85).
 *
 * An endpoint row that has gone missing falls back to this machine, which is
 * also what `onDelete: SetNull` leaves behind — a bot is never stranded
 * because its endpoint was removed.
 */
async function botTarget(bot: {
  dockerEndpointId: string | null;
}): Promise<{ host: string | null; name: string | null }> {
  if (!bot.dockerEndpointId) return { host: null, name: null };
  const ep = await prisma.dockerEndpoint.findUnique({
    where: { id: bot.dockerEndpointId },
    select: { host: true, name: true },
  });
  return ep ? { host: ep.host, name: ep.name } : { host: null, name: null };
}

/** The mounts for a computer: this machine's folders, or volumes on its daemon. */
function mountsFor(bot: { id: string; name: string }, dockerHost: string | null) {
  return dockerHostKind(dockerHost) === "remote" ? botVolumes(bot) : botMounts(bot);
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
  const target = await botTarget(bot);
  if (target.host) {
    // The endpoint probe rather than `dockerAvailable`: both ask the daemon one
    // question, but only the probe keeps the answer. "Not answering" is the one
    // thing the user cannot act on — a changed host key, an untrusted one, a
    // daemon that is down, docker missing from that user's PATH and a machine
    // that is simply asleep all look identical until the stderr is shown.
    const probed = await probeDockerEndpoint(target.host);
    // The answer is written back to the endpoint, so Settings cannot sit on a
    // stale green while a bot is being told the same machine is unreachable.
    // Those two disagreeing is worse than either being wrong.
    if (bot.dockerEndpointId) {
      await prisma.dockerEndpoint
        .update({ where: { id: bot.dockerEndpointId }, data: probeColumns(probed) })
        .catch(() => undefined);
    }
    if (!probed.ok) {
      throw new Error(`"${target.name ?? target.host}" could not run this computer: ${probed.error}`);
    }
  } else if (!(await dockerAvailable())) {
    // Naming the endpoint matters the other way too: this message must only
    // ever be said about this machine's own Docker.
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
      dockerHost: target.host,
      vncPassword: randomBytes(6).toString("hex"),
    },
  });
  void bootSession(session.id, claude.token);
  return session;
}

async function bootSession(sessionId: string, claudeToken: string): Promise<void> {
  const session = await prisma.botSession.findUnique({ where: { id: sessionId }, include: { bot: true } });
  if (!session) return;
  const target = { host: session.dockerHost };
  let build = { step: null as string | null, line: null as string | null };
  bootProgress.set(sessionId, "Preparing the computer…");
  try {
    const { vncPort } = await launchBotContainer({
      name: session.containerName,
      target,
      env: {
        CLAUDE_CODE_OAUTH_TOKEN: claudeToken,
        VNC_PASSWORD: session.vncPassword ?? "",
      },
      // The shared workspace and its browser profile outlive the computer.
      mounts: mountsFor(session.bot, session.dockerHost),
      onLog: (chunk) => {
        build = buildProgress(build, chunk);
        if (build.step || build.line) bootProgress.set(sessionId, formatBuildProgress(build));
      },
    });
    // What goes on the row is the port on *this* machine: the published one for
    // a local daemon, an SSH forward's for a remote one.
    const localPort = await botScreenLocalPort({
      sessionId,
      dockerHost: session.dockerHost,
      remotePort: vncPort,
    });
    if (localPort === null) throw new Error("could not forward the computer's screen from the endpoint");
    await prisma.botSession.update({ where: { id: sessionId }, data: { vncPort: localPort } });
    bootProgress.set(sessionId, "Waiting for the desktop and Chromium to come up…");

    const deadline = Date.now() + READY_TIMEOUT_MS;
    for (;;) {
      // Ended by the user while booting: the stop path already cleaned up.
      const current = await prisma.botSession.findUnique({ where: { id: sessionId } });
      if (!current || current.status !== "starting") {
        await stopBotContainer(session.containerName, target);
        return;
      }
      const state = await botReadiness(session.containerName, target);
      if (state === "ready") break;
      if (typeof state === "object") throw new Error(state.failed);
      if (Date.now() > deadline) throw new Error("the desktop did not come up in 3 minutes");
      await sleep(READY_POLL_MS);
    }

    // The team's sign-ins, before the first task runs.
    bootProgress.set(sessionId, "Signing in like the rest of the team…");
    await seedComputer(session.botId, session.containerName, session.dockerHost).catch((err) =>
      console.warn("[bots] could not seed sign-ins:", err instanceof Error ? err.message : err),
    );
    await prisma.botSession.update({
      where: { id: sessionId },
      data: { status: "ready", lastActivityAt: new Date() },
    });
    kickBotWorker(sessionId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await stopBotContainer(session.containerName, target);
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
    if (s) void shareSignIns(botId, s.containerName, s.dockerHost);
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
export async function shareSignIns(
  botId: string,
  container: string,
  dockerHost: string | null = null,
): Promise<void> {
  try {
    const others = await prisma.botSession.findMany({
      where: { status: "ready", botId: { not: botId } },
      select: { botId: true, containerName: true, dockerHost: true },
    });
    await shareFromComputer(
      botId,
      container,
      others.map((o) => ({
        botId: o.botId,
        container: o.containerName,
        dockerHost: o.dockerHost,
      })),
      dockerHost,
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
  // Every way a session ends passes through here, so this is the one place the
  // screen forward has to be dropped. A no-op when the daemon was local.
  closeBotScreenForward(sessionId);
  // Read before the row is closed: which daemon this computer was on decides
  // whether the endpoint's return tunnel still has a user.
  const ended = await prisma.botSession.findUnique({
    where: { id: sessionId },
    select: { dockerHost: true },
  });
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
  // The return tunnel belongs to the endpoint, not to this session: it goes
  // only once the last computer there is gone (D-88).
  const host = ended?.dockerHost;
  if (host) {
    const others = await prisma.botSession.count({
      where: { dockerHost: host, status: { in: [...ACTIVE_SESSION_STATUSES] } },
    });
    if (others === 0) await closeNexusReach(host).catch(() => undefined);
  }
}

/** Delete the bot's computer. Anything queued or running is canceled. */
export async function stopBotSession(botId: string): Promise<void> {
  const sessions = await prisma.botSession.findMany({
    where: { botId, status: { in: [...ACTIVE_SESSION_STATUSES] } },
  });
  for (const s of sessions) {
    // Last chance to keep what was signed into on this computer.
    if (s.status === "ready") await shareSignIns(botId, s.containerName, s.dockerHost);
    // Settle first so the worker and the booter both see the session gone.
    await endSession(s.id, "stopped");
    const running = await prisma.botRun.findMany({
      where: { sessionId: s.id },
      select: { id: true },
    });
    for (const r of running) aborts.get(r.id)?.abort();
    await stopBotContainer(s.containerName, { host: s.dockerHost });
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

    // Teammates it can hand work to are its workspace's (D-87): the roster in
    // the system prompt and the delivery in deliverHandoffs must name the same
    // bots, or the bot writes a handoff to someone it cannot reach.
    const team = await prisma.bot.findMany({
      where: { id: { not: session.botId }, workspaceId: session.bot.workspaceId },
      orderBy: { createdAt: "asc" },
      select: { name: true, role: true },
    });
    // Its own MCP servers, as saved (validated on save; re-checked in case of hand edits).
    const own = validateBotMcpServers(session.bot.mcpServers);
    // The vault (spec 32): entries this bot may use. {{secret:name}} in its MCP
    // servers resolve now, at the moment they go into its computer; logins,
    // cards and contacts it uses through the vault MCP server, never reading them.
    const vault = (await prisma.vaultItem.findMany({ orderBy: [{ type: "asc" }, { name: "asc" }] })).filter((v) =>
      botMayUse(v, session.botId),
    );
    const secretOf = (name: string) => {
      const v = vault.find((x) => x.type === "secret" && x.name === name);
      const value = (v?.secret as { value?: unknown } | undefined)?.value;
      return typeof value === "string" ? value : null;
    };
    const resolved = own.ok && own.servers ? resolveSecretRefs(own.servers, secretOf) : null;
    // Connected apps (spec 35) it may use; its own server of the same name wins.
    const connected = await connectorServersFor(session.botId).catch((err) => {
      console.warn(`[bots] ${session.bot.name}: connectors not loaded:`, err instanceof Error ? err.message : err);
      return {};
    });
    const merged = { ...connected, ...(resolved?.servers ?? {}) };
    const mcpServers = Object.keys(merged).length ? merged : null;
    for (const m of resolved?.missing ?? []) {
      console.warn(`[bots] ${session.bot.name}: MCP server "${m.server}" skipped — no vault secret "${m.secret}" it may use`);
    }
    const fillable = vault.filter((v) => (FILLABLE[v.type as VaultType] ?? []).length > 0);
    // Nexus as *this* computer reaches it: itself when the daemon is here, a
    // return tunnel when it is on another machine (D-88). A computer that
    // cannot reach Nexus is not a failure to start — it just does its work
    // without the vault, and says so in the log rather than letting the bot
    // discover it as "fetch failed" halfway through a task.
    let nexusUrl = hostAppUrl();
    let nexusReachable = true;
    try {
      nexusUrl = await botNexusUrl(session.dockerHost);
    } catch (err) {
      nexusReachable = false;
      console.warn(`[bots] ${session.bot.name}: ${err instanceof Error ? err.message : err}`);
    }
    // Gmail (spec 34) and Calendar (spec 36) through the connector: only when
    // this computer can reach Nexus, since every call goes through it.
    const googleFor = (app: "gmail" | "calendar") =>
      nexusReachable
        ? googleAccountsFor(session.botId, app).catch((err) => {
            console.warn(`[bots] ${session.bot.name}: ${app} accounts not loaded:`, err instanceof Error ? err.message : err);
            return [];
          })
        : Promise.resolve([]);
    const [gmail, calendar] = await Promise.all([googleFor("gmail"), googleFor("calendar")]);
    const systemPrompt = renderBotSystemPrompt({
      name: session.bot.name,
      role: session.bot.role,
      instructions: session.bot.instructions,
      needsInputMarker: NEEDS_INPUT_MARKER,
      timezone: hostTimezone(),
      hostAppUrl: nexusUrl,
      teammates: team,
      workspaceFolder: workspaceFolderFor(session.bot.name),
      mcpServers: mcpServers ? Object.keys(mcpServers) : [],
      skippedMcp: resolved?.missing.map((m) => `${m.server} (needs the vault secret "${m.secret}")`) ?? [],
      vault: fillable.map((v) => ({
        type: v.type,
        name: v.name,
        websites: Array.isArray(v.websites) ? (v.websites as string[]) : [],
        username: v.username,
        hint: v.hint,
      })),
      gmail: gmail.map((a) => a.email),
      calendar: calendar.map((a) => a.email),
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
    // Files the user attached: copied into the computer, read by path.
    if (prompt.includes(run.prompt)) {
      const own = await deliverAttachments({
        botId: session.botId,
        prompt: run.prompt,
        container: session.containerName,
        dockerHost: session.dockerHost,
        workdir: botWorkdir(session.bot.name),
      }).catch((err) => {
        console.warn("[bots] could not deliver attachments:", err instanceof Error ? err.message : err);
        return run.prompt;
      });
      if (own !== run.prompt) prompt = prompt.replace(run.prompt, () => own);
    }
    // Links to the user's machine, reachable from the container.
    prompt = absolutizeNexusLinks(toContainerUrls(prompt, nexusUrl), nexusUrl);

    const abort = new AbortController();
    aborts.set(run.id, abort);
    const log = createRunLog(run.id);
    // Valid only while this prompt runs.
    const vaultToken = fillable.length || gmail.length || calendar.length ? grantVault({
          botId: session.botId,
          runId: run.id,
          container: session.containerName,
          dockerHost: session.dockerHost,
        }) : null;
    try {
      // Rewritten every prompt, so a settings change applies on the next message.
      let userMcp = false;
      try {
        const servers: Record<string, unknown> = { ...(mcpServers ?? {}) };
        if (vaultToken && nexusReachable && fillable.length) {
          await writeBotVaultScripts(session.containerName, { host: session.dockerHost });
          servers.vault = botVaultMcpServer({ nexusUrl, botId: session.botId, token: vaultToken });
        }
        if (vaultToken && gmail.length) {
          await writeBotGmailScript(session.containerName, { host: session.dockerHost });
          servers.gmail = botGmailMcpServer({ nexusUrl, botId: session.botId, token: vaultToken });
        }
        if (vaultToken && calendar.length) {
          await writeBotCalendarScript(session.containerName, { host: session.dockerHost });
          servers.calendar = botCalendarMcpServer({ nexusUrl, botId: session.botId, token: vaultToken });
        }
        const any = Object.keys(servers).length > 0;
        await writeBotMcpConfig(session.containerName, any ? servers : null, {
          host: session.dockerHost,
        });
        userMcp = any;
      } catch (err) {
        console.warn(`[bots] ${session.bot.name}: MCP servers not loaded:`, err instanceof Error ? err.message : err);
      }
      const result = await runBotPrompt(prompt, {
        container: session.containerName,
        target: { host: session.dockerHost },
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
          dockerHost: session.dockerHost,
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
      revokeVault(vaultToken);
    }
    // Anything it signed into (or out of) during the task reaches the team.
    await shareSignIns(session.botId, session.containerName, session.dockerHost);
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
  // A handoff reaches the sender's own workspace (D-87) — the roster the bot
  // was given is that workspace's, so anything else is a name it never saw.
  const from = await prisma.bot.findUnique({
    where: { id: opts.fromId },
    select: { workspaceId: true },
  });
  if (!from) return 0;
  const team = await prisma.bot.findMany({
    where: { id: { not: opts.fromId }, workspaceId: from.workspaceId },
    select: { id: true, name: true },
  });
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
/** A container is identified by its name *and* its daemon, never by name alone. */
export type BotContainerRef = { name: string; dockerHost: string | null };

const refKey = (c: BotContainerRef) => `${c.dockerHost ?? ""}\u0000${c.name}`;

/**
 * A container name is derived from the bot's id, so the same name can exist on
 * two daemons at once — a bot that ran on an endpoint and was then pointed at
 * this machine leaves one behind. Matching on the name alone would adopt the
 * wrong one, or remove a live computer; both halves of the key are needed
 * (D-85).
 */
export function planRecovery(
  sessions: { id: string; status: string; containerName: string; dockerHost: string | null }[],
  containers: BotContainerRef[],
): { adopt: string[]; end: string[]; remove: BotContainerRef[] } {
  const present = new Set(containers.map(refKey));
  const key = (s: { containerName: string; dockerHost: string | null }) =>
    refKey({ name: s.containerName, dockerHost: s.dockerHost });
  const adopt = sessions.filter((s) => s.status === "ready" && present.has(key(s)));
  const kept = new Set(adopt.map(key));
  return {
    adopt: adopt.map((s) => s.id),
    end: sessions.filter((s) => !adopt.includes(s)).map((s) => s.id),
    remove: containers.filter((c) => !kept.has(refKey(c))),
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
    select: { id: true, status: true, containerName: true, dockerHost: true },
  });
  // Computers can be spread across daemons, so every one Nexus knows about is
  // asked: this machine, plus each endpoint. An endpoint that does not answer
  // is skipped rather than fatal — the rest of recovery still has to happen.
  const hosts: (string | null)[] = [
    null,
    ...(await prisma.dockerEndpoint.findMany({ select: { host: true } })).map((e) => e.host),
  ];
  const containers: BotContainerRef[] = [];
  for (const host of hosts) {
    for (const name of await listBotContainers({ host })) containers.push({ name, dockerHost: host });
  }
  const plan = planRecovery(sessions, containers);
  const now = new Date();
  for (const id of plan.adopt) {
    const s = sessions.find((x) => x.id === id)!;
    const target = { host: s.dockerHost };
    if ((await botReadiness(s.containerName, target)) !== "ready") {
      await stopBotContainer(s.containerName, target);
      await endSession(id, "stopped", "Nexux restarted — the computer was deleted");
      continue;
    }
    await stopBotClaudeRuns(s.containerName, target);
    // The old process owned the SSH forward, so a remote computer's screen has
    // to be found and forwarded again — and its local port is a new one.
    if (dockerHostKind(s.dockerHost) === "remote") {
      const remotePort = await botScreenPort(s.containerName, target);
      const localPort = remotePort
        ? await botScreenLocalPort({ sessionId: id, dockerHost: s.dockerHost, remotePort })
        : null;
      await prisma.botSession.update({ where: { id }, data: { vncPort: localPort } });
    }
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
  for (const c of plan.remove) {
    await stopBotContainer(c.name, { host: c.dockerHost });
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
