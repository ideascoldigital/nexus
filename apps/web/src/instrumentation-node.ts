// Everything the server startup hook does that only the Node.js runtime can do:
// ptys, the Prisma client, the filesystem.
//
// It lives in its own module because `instrumentation.ts` is compiled for the
// edge runtime too. A `process.env.NEXT_RUNTIME !== "nodejs"` early return stops
// this code from *running* there, but not from being *bundled* — webpack still
// has to resolve every import behind it, and dies on `fs/promises`, which the
// edge runtime does not have. Behind a single guarded dynamic import the
// bundler can leave the whole module out of the edge build, which is the shape
// Next documents for exactly this reason.
export async function registerNode() {
  // One server per database, before anything else runs: the recovery pass
  // below treats every in-flight task as orphaned, which is only true when no
  // other server is running against the same file. See instance-lock.ts.
  // From the client-free entry: importing "@nexux/db" would migrate first.
  const { acquireInstanceLock, databasePath, describeLockConflict } = await import(
    "@nexux/db/instance-lock"
  );
  const origin =
    process.env.NEXUX_WEB_ORIGIN ??
    `http://${process.env.HOSTNAME ?? "localhost"}:${process.env.PORT ?? "3000"}`;
  const lock = acquireInstanceLock(databasePath(), { origin });
  if (!lock.ok) {
    console.error(describeLockConflict(lock));
    process.exit(1);
  }
  process.once("exit", lock.release);
  console.log(`[instrumentation] holding ${lock.path}`);

  // The vault (spec 32): check the key against the database and seal any
  // secret still stored in plaintext — before anything reads one. A wrong key
  // is fatal: every credential read would fail, and nothing was changed.
  try {
    const { ensureVault } = await import("@nexux/db");
    const report = await ensureVault();
    const sealed = Object.entries(report.sealed).map(([m, n]) => `${m} ${n}`).join(", ");
    console.log(`[vault] key from ${report.keySource}${sealed ? `; sealed ${sealed}` : ""}`);
  } catch (err) {
    console.error("[vault]", err instanceof Error ? err.message : err);
    process.exit(1);
  }

  // In dev, `pnpm dev` may already run the standalone terminal server; let an
  // explicit opt-out skip the in-process one to avoid a port clash.
  if (process.env.NEXUX_DISABLE_INPROC_TERMINAL !== "1") {
    try {
      const { startTerminalServer } = await import(
        "@nexux/terminal/terminal-server"
      );
      // Sessions on another machine's Docker name an endpoint id; the host
      // comes from the database, never from the browser (spec 26).
      const handle = startTerminalServer({
        resolveDockerHost: async (endpointId) => {
          const { prisma } = await import("@nexux/db");
          const endpoint = await prisma.dockerEndpoint.findUnique({
            where: { id: endpointId },
            select: { host: true },
          });
          return endpoint?.host ?? null;
        },
      });
      console.log(`[instrumentation] terminal server up on :${handle.port}`);
    } catch (err) {
      console.error("[instrumentation] terminal server failed to start:", err);
    }
  }

  // Workspaces: the seeded default must exist before any scoped query runs.
  try {
    const { ensureDefaultWorkspace } = await import("@/lib/workspace");
    await ensureDefaultWorkspace();
  } catch (err) {
    console.error("[instrumentation] default workspace check failed:", err);
  }

  // Telegram notifications + remote control. Idles cheaply (30s polls of the
  // Settings table) until a bot token is configured.
  if (process.env.NEXUX_DISABLE_TELEGRAM !== "1") {
    try {
      const { startTelegramPoller } = await import("@/lib/telegram");
      startTelegramPoller();
      console.log("[instrumentation] telegram poller started");
    } catch (err) {
      console.error("[instrumentation] telegram poller failed to start:", err);
    }
  }

  // Slack remote control: an outbound Socket Mode WebSocket — the Telegram
  // poller's equivalent. Idles cheaply until both Slack tokens exist.
  if (process.env.NEXUX_DISABLE_SLACK !== "1") {
    try {
      const { startSlackSocket } = await import("@/lib/slack-socket");
      startSlackSocket();
      console.log("[instrumentation] slack socket started");
    } catch (err) {
      console.error("[instrumentation] slack socket failed to start:", err);
    }
  }

  // Scheduled agent tasks (ephemeral sandbox → task → PR → destroy).
  if (process.env.NEXUX_DISABLE_SCHEDULER !== "1") {
    try {
      const { startTaskScheduler } = await import("@/lib/task-scheduler");
      startTaskScheduler();
      console.log("[instrumentation] task scheduler started");
    } catch (err) {
      console.error("[instrumentation] task scheduler failed to start:", err);
    }
    try {
      // Both drivers live in-process: first settle sandboxes whose
      // provision/destroy died with the previous process, then re-attach
      // supervision to whatever it left queued.
      // A host's home is rebuilt on every update: put back the ssh config its
      // endpoints are reached with before anything reaches for one.
      const { restoreEndpointSsh } = await import("@/lib/docker-endpoints");
      await restoreEndpointSsh().catch((err) => console.error("[instrumentation] endpoint ssh restore failed:", err));
      const { recoverOrphanSandboxes } = await import("@/lib/sandbox-manager");
      await recoverOrphanSandboxes();
      const { recoverPendingLaunches, recoverOrphanTasks } = await import(
        "@/lib/task-manager"
      );
      // Fail the runner-less ones first, then re-attach to what can still be
      // supervised — the two select disjoint sets, and doing it in this order
      // means a task is never briefly both.
      await recoverOrphanTasks();
      void recoverPendingLaunches();
      // Dev-console queues: fail orphaned running prompts, resume queued ones.
      const { recoverDevQueues } = await import("@/lib/dev-console");
      void recoverDevQueues();
      // Plan-mode runs have no queue to resume — just settle the orphans.
      const { recoverPlanRuns } = await import("@/lib/plan-runner");
      void recoverPlanRuns();
      // Browser sessions are served by an SSH forward that was a child of the
      // previous process, so every row still saying "running" is backed by
      // nothing. Left alone the tab offers an iframe that can never connect.
      const { reapForwards } = await import("@/lib/browser-session");
      void reapForwards();
      // Bots: a dead process leaves unsupervised desktop containers behind —
      // delete them, settle their rows, then start the idle reaper.
      const { recoverBots } = await import("@/lib/bot-manager");
      void recoverBots();
    } catch (err) {
      console.error("[instrumentation] launch recovery failed:", err);
    }
  }
}
